package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type titleReconcileInput struct {
	HistoryEpoch   int64  `json:"historyEpoch"`
	Head           int64  `json:"head"`
	DirectoryTitle string `json:"directoryTitle"`
	DocumentTitle  string `json:"documentTitle"`
}

// Reconstruct the title at an exact history point instead of trusting the client.
func (s *Server) reconcileTitleConsistency(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	meta, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if meta.Kind != "doc" {
		httpx.Error(w, http.StatusBadRequest, "invalid_kind", "仅文档支持标题一致性修复")
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
	var in titleReconcileInput
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&in) != nil || decoder.Decode(&struct{}{}) != io.EOF || in.HistoryEpoch < 1 || in.HistoryEpoch > conditionalSafeInteger || in.Head < 0 || in.Head > conditionalSafeInteger || len(in.DirectoryTitle) > 4096 || len(in.DocumentTitle) > 4096 {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "标题检查结果无效")
		return
	}
	select {
	case titleCheckSlots <- struct{}{}:
		defer func() { <-titleCheckSlots }()
	default:
		httpx.Error(w, http.StatusServiceUnavailable, "title_check_busy", "标题检查繁忙，请稍后重试")
		return
	}
	epoch, head, err := s.Store.HeadVersion(r.Context(), meta.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if epoch != in.HistoryEpoch || head != in.Head {
		httpx.Error(w, http.StatusConflict, "title_changed", "文档已变化，请重新检查")
		return
	}
	snapshot, err := s.Store.ReadTitleSnapshot(r.Context(), meta.ID)
	if errors.Is(err, store.ErrTitleSnapshotTooLarge) {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "title_check_too_large", "文档内容过大，暂无法检查标题")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if snapshot.Head != in.Head || snapshot.DirectoryTitle != in.DirectoryTitle {
		httpx.Error(w, http.StatusConflict, "title_changed", "名称已变化，请重新检查")
		return
	}
	title, err := materializeTitle(r.Context(), snapshot)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if title != in.DocumentTitle {
		httpx.Error(w, http.StatusConflict, "title_changed", "文档标题已变化，请重新检查")
		return
	}
	clean := strings.TrimSpace(title)
	if clean != title {
		httpx.Error(w, http.StatusBadRequest, "invalid_title", "请先移除文档标题首尾空白，再同步目录名称")
		return
	}
	if utf8.RuneCountInString(clean) > 200 {
		httpx.Error(w, http.StatusBadRequest, "invalid_title", "文档标题超过 200 个字符，无法同步到目录")
		return
	}
	target, ok := s.Store.(store.TitleReconciler)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "标题修复暂不可用")
		return
	}
	err = target.ReconcileDocumentTitle(r.Context(), guard, meta.ID, in.HistoryEpoch, in.Head, in.DirectoryTitle, clean)
	if driveWriteErr(w, err, "title reconcile") {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
