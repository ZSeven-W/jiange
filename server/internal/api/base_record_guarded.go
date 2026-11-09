package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type invalidRecordCells struct{ message string }

func (e invalidRecordCells) Error() string { return e.message }

// mutateRecordGuarded applies the row, reciprocal links and their events in
// one transaction after rechecking the original session and all Base grants.
func (s *Server) mutateRecordGuarded(w http.ResponseWriter, r *http.Request, operation string) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in struct {
		Cells    map[string]json.RawMessage `json:"cells"`
		Position float64                    `json:"position"`
		Move     bool                       `json:"move"`
	}
	if operation != "delete" && r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	if operation == "update" && in.Move {
		operation = "move"
	}
	u, _ := UserFrom(r.Context())
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
		return
	}
	guard := store.BaseWriteGuard{UserID: u.ID, SessionHash: auth.HashToken(cookie.Value), Now: s.now}
	if operation == "add" && in.Cells == nil {
		in.Cells = map[string]json.RawMessage{}
	}
	mutation := store.BaseRecordMutation{Operation: operation, RecordID: pathID(r, "rid"), Cells: in.Cells, Position: in.Position}
	record, affected, err := s.Store.MutateRecordGuarded(r.Context(), guard, b.ID, mutation, func(fields []store.Field) error {
		if msg := checkCells(fields, in.Cells); msg != "" {
			return invalidRecordCells{msg}
		}
		if operation == "add" {
			// 默认值: fill omitted cells from the field defaults read in this transaction.
			for _, f := range fields {
				k := strconv.FormatInt(f.ID, 10)
				if _, given := in.Cells[k]; !given && len(f.DefaultValue) > 0 && defaultableTypes[f.Type] && validCell(f, f.DefaultValue) {
					in.Cells[k] = f.DefaultValue
				}
			}
		}
		return nil
	})
	var invalid invalidRecordCells
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效，记录未修改")
		return
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限不允许修改记录或关联表")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "记录不存在")
		return
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "conflict", "记录或表结构已变化，请重试")
		return
	case errors.As(err, &invalid):
		httpx.Error(w, http.StatusBadRequest, "invalid_cell", invalid.message)
		return
	case errors.Is(err, store.ErrInvalidBaseRecord):
		httpx.Error(w, http.StatusBadRequest, "invalid_cell", "记录或关联目标无效")
		return
	case err != nil:
		s.fail(w, r, err)
		return
	}
	if s.BtHub != nil {
		for _, id := range affected {
			s.BtHub.Notify(id)
		}
	}
	if operation == "delete" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.runAutomations(r.Context(), b.ID, "record_matches", record)
	status := http.StatusOK
	if operation == "add" {
		status = http.StatusCreated
	}
	s.writeProjectedRecord(w, r, u.ID, b.ID, record.ID, status)
}

// The transaction's record contains raw link IDs, including targets this
// caller may no longer read. Re-fetch through the same policy/projection as
// GET before returning anything to the client.
func (s *Server) writeProjectedRecord(w http.ResponseWriter, r *http.Request, userID, baseID, recordID int64, status int) {
	w.Header().Set("Cache-Control", "private, no-store")
	read, err := s.readProjectionPolicy(r.Context(), userID, baseID)
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "记录已修改，但当前无法查看；请刷新后核对")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	row, err := s.Store.RecordConstrained(r.Context(), baseID, recordID, read.allFields, read.policy.mandatory)
	if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "记录已修改，但当前无法查看；请刷新后核对")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	read.records = stripBaseRecords([]store.Record{row}, read.allFields, read.policy)
	// Project only the response row; unreferenced rows must not contribute
	// target IDs or cause unnecessary link expansion work.
	targets, err := s.projectRecordLinks(r.Context(), userID, &read)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// The mutation has already committed. If any source/target grant changed
	// while projecting, never imply the write was rolled back or invite an
	// automatic retry; the client must refresh and verify the result.
	for _, snapshot := range append([]baseReadable{read}, targets...) {
		if err := s.recheckBaseRead(r.Context(), r, snapshot); err != nil {
			if errors.Is(err, store.ErrForbidden) || errors.Is(err, store.ErrNotFound) {
				httpx.Error(w, http.StatusForbidden, "access_changed_after_write", "记录已修改，但访问权限已变化；请勿重复提交，刷新后核对")
				return
			}
			if errors.Is(err, store.ErrConflict) {
				httpx.Error(w, http.StatusConflict, "access_changed_after_write", "记录已修改，但权限或字段已变化；请勿重复提交，刷新后核对")
				return
			}
			s.fail(w, r, err)
			return
		}
	}
	if len(read.records) != 1 {
		httpx.Error(w, http.StatusConflict, "access_changed", "记录已修改，但当前无法查看；请刷新后核对")
		return
	}
	httpx.JSON(w, status, read.records[0])
}
