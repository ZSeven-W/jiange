package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const conditionalBatchLimit = 8 << 20
const conditionalJSONLimit = 12 << 20
const conditionalMaxOps = 100000
const conditionalSafeInteger = 1<<53 - 1

var conditionalCellKey = regexp.MustCompile(`^tbl\.c\.[A-Za-z0-9_-]{1,40}\.[A-Za-z0-9_-]{1,40}$`)
var conditionalColumnID = regexp.MustCompile(`^\d+:\d+$`)
var conditionalColumnPosition = regexp.MustCompile(`^[0-9A-Za-z]{1,512}$`)

type conditionalOpsInput struct {
	Epoch     int64  `json:"historyEpoch"`
	Head      int64  `json:"expectedSeq"`
	RequestID string `json:"requestId"`
	Batch     []byte `json:"batch"`
}

// getConditionalOpsStatus never claims that an absent receipt is final: an
// earlier submission may still be in flight. It exposes no operation bytes.
func (s *Server) getConditionalOpsStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "未确认当前账号")
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	request := r.PathValue("requestId")
	if !versionEntryRequest.MatchString(request) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "请求标识无效")
		return
	}
	st, ok := s.Store.(store.ConditionalOpsStatusReader)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "条件提交查询暂不可用")
		return
	}
	result, err := st.ConditionalOpsStatus(r.Context(), guard, d.ID, request)
	if driveWriteErr(w, err, "conditional operation status") {
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

func conditionalTableKey(key string) bool {
	switch key {
	case "tableData", "tbl.v", "tbl.base", "tbl.rows", "tbl.cols", "tbl.m":
		return true
	default:
		return conditionalCellKey.MatchString(key)
	}
}

func conditionalTextBlock(kind string) bool {
	switch kind {
	case "paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "bullet", "ordered", "todo", "quote", "code", "callout":
		return true
	default:
		return false
	}
}

func conditionalAlignment(op collab.Op) bool {
	if op.Key != "align" || op.Value == nil {
		return false
	}
	switch *op.Value {
	case "", "left", "center", "right":
		return true
	default:
		return false
	}
}

func conditionalAlignableBlock(kind string) bool {
	return kind != "code" && conditionalTextBlock(kind)
}

func conditionalColumnWidths(op collab.Op) bool {
	if op.Key != "columnWidths" || op.Value == nil || len(*op.Value) > 32000 {
		return false
	}
	if *op.Value == "" {
		return true
	}
	decoder := json.NewDecoder(bytes.NewBufferString(*op.Value))
	decoder.UseNumber()
	var values map[string]any
	if decoder.Decode(&values) != nil || values == nil || len(values) > 1000 {
		return false
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return false
	}
	var total float64
	for key, value := range values {
		if !conditionalColumnID.MatchString(key) {
			return false
		}
		parts := strings.Split(key, ":")
		for _, part := range parts {
			id, err := strconv.ParseUint(part, 10, 64)
			if err != nil || id > conditionalSafeInteger {
				return false
			}
		}
		number, ok := value.(json.Number)
		if !ok {
			return false
		}
		weight, err := number.Float64()
		if err != nil || math.IsNaN(weight) || math.IsInf(weight, 0) || weight < 1 || weight > 1_000_000_000 || math.Trunc(weight) != weight {
			return false
		}
		total += weight
		if total > 1_000_000_000 {
			return false
		}
	}
	return true
}

// commitConditionalOps accepts text changes, table-cell properties, bounded column layout updates, and same-parent column moves.
// A durable receipt makes an exact retry safe even after the head advances.
// This endpoint alone cannot prevent stale writes from older sync clients.
func (s *Server) commitConditionalOps(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "未确认当前账号")
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	st, ok := s.Store.(store.ConditionalOpsCommitter)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "条件提交暂不可用")
		return
	}
	var in conditionalOpsInput
	r.Body = http.MaxBytesReader(w, r.Body, conditionalJSONLimit)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "无效的提交内容")
		return
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "无效的提交内容")
		return
	}
	if in.Epoch < 1 || in.Epoch > conditionalSafeInteger || in.Head < 0 || in.Head > conditionalSafeInteger || !versionEntryRequest.MatchString(in.RequestID) || len(in.Batch) == 0 || len(in.Batch) > conditionalBatchLimit {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "提交内容或同步状态无效")
		return
	}
	ops, err := collab.DecodeOps(in.Batch)
	if err != nil || len(ops) == 0 || len(ops) > conditionalMaxOps || int64(len(ops)) > conditionalSafeInteger-in.Head {
		httpx.Error(w, http.StatusBadRequest, "invalid_ops", "提交操作无效")
		return
	}
	client := ops[0].ID.Client
	if client == 0 || client > conditionalSafeInteger {
		httpx.Error(w, http.StatusBadRequest, "invalid_ops", "提交操作无效")
		return
	}
	uid, docID, err := s.Store.ClientOwner(r.Context(), int64(client))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, err)
		return
	}
	if err != nil || uid != guard.UserID || docID != d.ID {
		httpx.Error(w, http.StatusForbidden, "forbidden", "操作作者不属于当前文档和账号")
		return
	}
	raws := make([]store.RawOp, len(ops))
	for i, op := range ops {
		if op.ID.Client != client || op.ID.Clock == 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_ops", "提交操作无效")
			return
		}
		switch op.T {
		case collab.TTextInsert:
			if op.Text == "" {
				httpx.Error(w, http.StatusBadRequest, "invalid_ops", "提交操作无效")
				return
			}
		case collab.TTextDelete:
			if op.Len == 0 {
				httpx.Error(w, http.StatusBadRequest, "invalid_ops", "提交操作无效")
				return
			}
		case collab.TMark:
		case collab.TBlockMove:
			if len(ops) != 1 || !conditionalColumnPosition.MatchString(op.Pos) || strings.HasSuffix(op.Pos, "0") {
				httpx.Error(w, http.StatusBadRequest, "invalid_ops", "分栏位置无效")
				return
			}
		case collab.TBlockSet:
			if !conditionalTableKey(op.Key) && !conditionalAlignment(op) && !conditionalColumnWidths(op) {
				httpx.Error(w, http.StatusBadRequest, "invalid_ops", "不支持此属性操作")
				return
			}
		default:
			httpx.Error(w, http.StatusBadRequest, "invalid_ops", "不支持此操作类型")
			return
		}
		encoded, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_ops", "提交操作无效")
			return
		}
		raws[i] = store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded}
	}
	lookup := func() bool {
		seqs, err := st.LookupConditionalOps(r.Context(), guard, d.ID, in.Epoch, in.Head, in.RequestID, raws)
		if err == nil {
			httpx.JSON(w, http.StatusOK, map[string]any{"sequences": seqs})
			return true
		}
		if errors.Is(err, store.ErrNotFound) {
			return false
		}
		return driveWriteErr(w, err, "lookup conditional operation")
	}
	if lookup() {
		return
	}
	epoch, head, err := s.Store.HeadVersion(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if epoch != in.Epoch || head != in.Head {
		if lookup() {
			return
		}
		httpx.Error(w, http.StatusConflict, "document_changed", "文档已变化，请同步后重新操作")
		return
	}
	state, materialized, err := StateAtHead(r.Context(), s.Store, d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if materialized != in.Head {
		if lookup() {
			return
		}
		httpx.Error(w, http.StatusConflict, "document_changed", "文档已变化，请同步后重新操作")
		return
	}
	blockKinds := make(map[collab.OpID]string)
	for _, op := range ops {
		kind, found := blockKinds[op.Block]
		if !found {
			var visible bool
			_, kind, visible = state.VisibleBlockText(op.Block)
			if !visible {
				httpx.Error(w, http.StatusBadRequest, "invalid_ops", "操作目标不可用")
				return
			}
			blockKinds[op.Block] = kind
		}
		if op.T == collab.TBlockMove && !state.CanReorderColumn(op.Block, op.Parent, op.Pos) || op.T == collab.TBlockSet && !(kind == "table" && conditionalTableKey(op.Key) || conditionalAlignableBlock(kind) && conditionalAlignment(op) || kind == "columns" && conditionalColumnWidths(op)) || op.T != collab.TBlockMove && op.T != collab.TBlockSet && !conditionalTextBlock(kind) {
			httpx.Error(w, http.StatusBadRequest, "invalid_ops", "操作目标类型不支持")
			return
		}
		if err = state.TryApply(op); err != nil {
			if lookup() {
				return
			}
			httpx.Error(w, http.StatusConflict, "invalid_history", "操作依赖已变化，请同步后重新操作")
			return
		}
	}
	seqs, err := st.CommitConditionalOps(r.Context(), guard, d.ID, in.Epoch, in.Head, in.RequestID, raws)
	if errors.Is(err, store.ErrOpIdentityConflict) {
		httpx.Error(w, http.StatusConflict, "operation_conflict", "操作标识已变化，请重新操作")
		return
	}
	if driveWriteErr(w, err, "commit conditional operation") {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"sequences": seqs})
}
