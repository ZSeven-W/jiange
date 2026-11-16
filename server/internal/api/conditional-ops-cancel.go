package api

import (
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"regexp"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

var conditionalDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type conditionalCancelInput struct {
	Epoch    int64  `json:"historyEpoch"`
	Head     int64  `json:"expectedSeq"`
	Count    int64  `json:"opCount"`
	ClientID int64  `json:"clientId"`
	Digest   string `json:"digest"`
}

// Cancellation serializes with conditional commits. It either returns the
// already-committed receipt or durably prevents that request ID from writing.
func (s *Server) cancelConditionalOps(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	doc, ok := s.need(w, r, store.RoleEdit)
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
	var in conditionalCancelInput
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&in) != nil || decoder.Decode(&struct{}{}) != io.EOF || in.Epoch < 1 || in.Epoch > conditionalSafeInteger || in.Head < 0 || in.Head >= conditionalSafeInteger || in.Count < 1 || in.Count > conditionalMaxOps || in.Count > conditionalSafeInteger-in.Head || in.ClientID < 1 || in.ClientID > conditionalSafeInteger || !conditionalDigestPattern.MatchString(in.Digest) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "操作记录无效")
		return
	}
	raw, err := hex.DecodeString(in.Digest)
	if err != nil || len(raw) != 32 {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "操作记录无效")
		return
	}
	var digest [32]byte
	copy(digest[:], raw)
	st, ok := s.Store.(store.ConditionalOpsCanceller)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "安全停止暂不可用")
		return
	}
	status, err := st.CancelConditionalOps(r.Context(), guard, doc.ID, in.Epoch, in.Head, in.Count, in.ClientID, request, digest)
	if driveWriteErr(w, err, "cancel conditional operation") {
		return
	}
	httpx.JSON(w, http.StatusOK, status)
}
