package api

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type versionEntryStore interface {
	CreateVersionEntry(context.Context, store.RestoreGuard, int64, int64, int64, []byte, string, string) (store.VersionEntry, error)
	ListVersionEntries(context.Context, store.RestoreGuard, int64) ([]store.VersionEntry, error)
}

var versionEntryRequest = regexp.MustCompile(`^[0-9a-f]{32}$`)

func (s *Server) versionEntryAccess(w http.ResponseWriter, r *http.Request, role string) (store.DocMeta, store.RestoreGuard, versionEntryStore, bool) {
	d, ok := s.need(w, r, role)
	if !ok {
		return store.DocMeta{}, store.RestoreGuard{}, nil, false
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return store.DocMeta{}, store.RestoreGuard{}, nil, false
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "未确认当前账号")
		return store.DocMeta{}, store.RestoreGuard{}, nil, false
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return store.DocMeta{}, store.RestoreGuard{}, nil, false
	}
	st, ok := s.Store.(versionEntryStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "版本服务不可用")
		return store.DocMeta{}, store.RestoreGuard{}, nil, false
	}
	return d, guard, st, true
}

func (s *Server) listVersionEntries(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	d, guard, st, ok := s.versionEntryAccess(w, r, store.RoleView)
	if !ok {
		return
	}
	entries, err := st.ListVersionEntries(r.Context(), guard, d.ID)
	if driveWriteErr(w, err, "list version entries") {
		return
	}
	if entries == nil {
		entries = []store.VersionEntry{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"versions": entries})
}

func (s *Server) createVersionEntry(w http.ResponseWriter, r *http.Request) {
	d, guard, st, ok := s.versionEntryAccess(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in struct {
		Label     string `json:"label"`
		Epoch     int64  `json:"historyEpoch"`
		Head      int64  `json:"expectedSeq"`
		RequestID string `json:"requestId"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	in.Label = strings.TrimSpace(in.Label)
	if in.Label == "" || utf8.RuneCountInString(in.Label) > 1000 || in.Epoch <= 0 || in.Head <= 0 || in.Head > 1<<53-1 || in.Epoch > 1<<53-1 || !versionEntryRequest.MatchString(in.RequestID) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "版本名称或同步状态无效")
		return
	}
	epoch, head, err := s.Store.HeadVersion(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if epoch != in.Epoch || head != in.Head {
		httpx.Error(w, http.StatusConflict, "version_conflict", "文档已变化，请同步完成后重新保存")
		return
	}
	doc, materializedHead, err := StateAtHead(r.Context(), s.Store, d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if materializedHead != in.Head {
		httpx.Error(w, http.StatusConflict, "version_conflict", "文档已变化，请同步完成后重新保存")
		return
	}
	entry, err := st.CreateVersionEntry(r.Context(), guard, d.ID, in.Epoch, in.Head, doc.EncodeState(), in.Label, in.RequestID)
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "version_conflict", "文档或保存请求已变化，请检查历史记录后重试")
		return
	}
	if driveWriteErr(w, err, "create version entry") {
		return
	}
	httpx.JSON(w, http.StatusCreated, entry)
}
