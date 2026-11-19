package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) pasteSlidesPageFrom(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "粘贴账号未确认")
		return
	}
	if !driveExpectedUser(w, r, u.ID) {
		return
	}
	target, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || target <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "目标幻灯片无效")
		return
	}
	var in struct {
		SourceDeck     *int64 `json:"sourceDeckId"`
		SourceID       *int64 `json:"sourceId"`
		SourceRevision *int64 `json:"sourceRevision"`
		AnchorID       *int64 `json:"anchorId"`
		AnchorRevision *int64 `json:"anchorRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.SourceDeck == nil || in.SourceID == nil || in.SourceRevision == nil || in.AnchorID == nil || in.AnchorRevision == nil || *in.SourceDeck <= 0 || *in.SourceDeck == target || *in.SourceID <= 0 || *in.SourceRevision <= 0 || *in.AnchorID <= 0 || *in.AnchorRevision <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_page", "来源页面或粘贴位置无效")
		return
	}
	source, err := s.Store.GetDoc(r.Context(), u.ID, *in.SourceDeck)
	if err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, store.ErrForbidden) {
		s.fail(w, r, err)
		return
	}
	if err != nil || source.Kind != "slides" || store.RoleRank(source.Role) < store.RoleRank(store.RoleView) {
		httpx.Error(w, http.StatusNotFound, "not_found", "来源演示文稿不存在或无权访问")
		return
	}
	if !store.DocumentCopyAllowed(source, source.Role) {
		httpx.Error(w, http.StatusForbidden, "copy_protected", "来源演示文稿不允许复制")
		return
	}
	pages, err := s.Store.ListSlidesPages(r.Context(), u.ID, *in.SourceDeck)
	if driveWriteErr(w, err, "read source slide") {
		return
	}
	var page *store.SlidesPage
	for i := range pages {
		if pages[i].ID == *in.SourceID {
			page = &pages[i]
			break
		}
	}
	if page == nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "来源页面不存在")
		return
	}
	if page.Revision != *in.SourceRevision {
		httpx.Error(w, http.StatusConflict, "conflict", "来源页面已变化，请重新复制")
		return
	}
	ids, err := store.SlideImageIDs(page.Shapes)
	if err != nil || len(ids) > maxCopyAttachments {
		httpx.Error(w, http.StatusConflict, "invalid_shapes", "来源页面图片无效或过多")
		return
	}
	if len(ids) > 0 && s.Blobs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "no_storage", "图片存储未配置，无法粘贴完整页面")
		return
	}
	if err = s.verifyCopyFiles(r.Context(), *in.SourceDeck, ids); err != nil {
		if errors.Is(err, errCopyAttachment) {
			httpx.Error(w, http.StatusConflict, "invalid_attachment", "来源图片不可用，未粘贴页面")
		} else if errors.Is(err, errCopyStorage) {
			httpx.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "图片存储暂不可用，未粘贴页面")
		} else {
			s.fail(w, r, err)
		}
		return
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	guarded, ok := s.Store.(store.SlidesCrossPasteStore)
	if !ok {
		httpx.Error(w, http.StatusUpgradeRequired, "upgrade_required", "请升级服务端以跨文稿粘贴")
		return
	}
	copied, mapping, err := guarded.PasteSlidesPageFrom(r.Context(), g, target, *in.SourceDeck, *in.SourceID, *in.SourceRevision, *in.AnchorID, *in.AnchorRevision, append([]int64{}, ids...))
	if errors.Is(err, store.ErrCopyProtected) {
		httpx.Error(w, http.StatusForbidden, "copy_protected", "来源演示文稿不允许复制")
		return
	}
	if driveWriteErr(w, err, "paste slide page") {
		return
	}
	s.notifySlides(target, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusCreated, map[string]any{"page": copied, "mapping": mapping})
}
