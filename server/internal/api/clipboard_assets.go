package api

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"sort"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type clipboardAssetStore interface {
	CopyClipboardAssets(context.Context, store.RestoreGuard, store.ClipboardAssetCopy) (map[int64]int64, error)
}

var clipboardIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func (s *Server) copyClipboardAssets(w http.ResponseWriter, r *http.Request) {
	target, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if target.Kind != "doc" {
		httpx.Error(w, http.StatusNotFound, "not_found", "目标文档不存在")
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "粘贴账号未确认")
		return
	}
	if !driveExpectedUser(w, r, g.UserID) {
		return
	}
	var in struct {
		SourceDocID int64   `json:"sourceDocId"`
		RequestID   string  `json:"requestId"`
		FileIDs     []int64 `json:"fileIds"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.SourceDocID <= 0 || !clipboardIDPattern.MatchString(in.RequestID) || len(in.FileIDs) == 0 || len(in.FileIDs) > 100 {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "附件复制请求无效")
		return
	}
	sort.Slice(in.FileIDs, func(i, j int) bool { return in.FileIDs[i] < in.FileIDs[j] })
	for i, id := range in.FileIDs {
		if id <= 0 || i > 0 && id == in.FileIDs[i-1] {
			httpx.Error(w, http.StatusBadRequest, "invalid_request", "附件列表无效")
			return
		}
	}
	source, err := s.Store.GetDoc(r.Context(), g.UserID, in.SourceDocID)
	if err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, store.ErrForbidden) {
		s.fail(w, r, err)
		return
	}
	if err != nil || source.Kind != "doc" || store.RoleRank(source.Role) < store.RoleRank(store.RoleView) {
		httpx.Error(w, http.StatusNotFound, "not_found", "源文档或附件不可访问")
		return
	}
	if !store.DocumentCopyAllowed(source, source.Role) || !store.DocumentDownloadAllowed(source, source.Role) {
		httpx.Error(w, http.StatusForbidden, "copy_protected", "无权复制源文档附件")
		return
	}
	st, ok := s.Store.(clipboardAssetStore)
	if !ok || s.Blobs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "附件复制服务不可用")
		return
	}
	if err = s.verifyCopyFiles(r.Context(), in.SourceDocID, in.FileIDs); err != nil {
		if errors.Is(err, errCopyAttachment) {
			httpx.Error(w, http.StatusConflict, "invalid_attachment", "源附件不可用，未粘贴")
		} else if errors.Is(err, errCopyStorage) {
			httpx.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "附件存储不可用，未粘贴")
		} else {
			s.fail(w, r, err)
		}
		return
	}
	mapping, err := st.CopyClipboardAssets(r.Context(), g, store.ClipboardAssetCopy{SourceDocID: in.SourceDocID, TargetDocID: target.ID, RequestID: in.RequestID, FileIDs: in.FileIDs})
	if errors.Is(err, store.ErrCopyProtected) {
		httpx.Error(w, http.StatusForbidden, "copy_protected", "无权复制源文档附件")
		return
	}
	if driveWriteErr(w, err, "copy clipboard assets") {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"mapping": mapping})
}
