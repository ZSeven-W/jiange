package api

import (
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) slidesExtrasGuard(w http.ResponseWriter, r *http.Request) (store.User, store.RestoreGuard, int64, store.SlidesExtrasStore, bool) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
		return store.User{}, store.RestoreGuard{}, 0, nil, false
	}
	if r.Header.Get("X-Jiange-User-Id") == "" {
		httpx.Error(w, http.StatusBadRequest, "missing_account", "操作账号未确认")
		return store.User{}, store.RestoreGuard{}, 0, nil, false
	}
	if !driveExpectedUser(w, r, u.ID) {
		return store.User{}, store.RestoreGuard{}, 0, nil, false
	}
	g, ok := s.driveGuard(w, r)
	if !ok {
		return store.User{}, store.RestoreGuard{}, 0, nil, false
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "幻灯片标识无效")
		return store.User{}, store.RestoreGuard{}, 0, nil, false
	}
	st, ok := s.Store.(store.SlidesExtrasStore)
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_supported", "当前存储不支持幻灯片批注与版本历史")
		return store.User{}, store.RestoreGuard{}, 0, nil, false
	}
	return u, g, id, st, true
}

func validSlidesCommentText(raw string) bool {
	b := strings.TrimSpace(raw)
	if !utf8.ValidString(b) || strings.ContainsRune(b, '\x00') {
		return false
	}
	n := utf8.RuneCountInString(b)
	return n >= 1 && n <= 2000
}

func validSlidesShapeTarget(raw string) bool {
	s := strings.TrimSpace(raw)
	if s == "" {
		return true
	}
	return utf8.ValidString(s) && !strings.ContainsRune(s, '\x00') && utf8.RuneCountInString(s) <= 64
}

func validSlidesVersionLabel(raw string) bool {
	s := strings.TrimSpace(raw)
	return utf8.ValidString(s) && !strings.ContainsRune(s, '\x00') && utf8.RuneCountInString(s) <= 120
}

func (s *Server) listSlidesComments(w http.ResponseWriter, r *http.Request) {
	_, g, id, st, ok := s.slidesExtrasGuard(w, r)
	if !ok {
		return
	}
	comments, err := st.ListSlidesComments(r.Context(), g, id)
	if driveWriteErr(w, err, "list slides comments") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"comments": comments})
}

func (s *Server) createSlidesComment(w http.ResponseWriter, r *http.Request) {
	_, g, id, st, ok := s.slidesExtrasGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		PageID  int64  `json:"pageId"`
		ShapeID string `json:"shapeId"`
		Body    string `json:"body"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.PageID <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_page_id", "页面标识无效")
		return
	}
	if !validSlidesShapeTarget(in.ShapeID) {
		httpx.Error(w, http.StatusBadRequest, "invalid_shape_id", "元素标识无效")
		return
	}
	if !validSlidesCommentText(in.Body) {
		httpx.Error(w, http.StatusBadRequest, "invalid_body", "评论内容需为 1-2000 字")
		return
	}
	cm, err := st.CreateSlidesCommentGuarded(r.Context(), g, id, in.PageID, in.ShapeID, in.Body)
	if driveWriteErr(w, err, "create slides comment") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusCreated, map[string]any{"comment": cm})
}

func (s *Server) patchSlidesComment(w http.ResponseWriter, r *http.Request) {
	_, g, id, st, ok := s.slidesExtrasGuard(w, r)
	if !ok {
		return
	}
	cid, err := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	if err != nil || cid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "评论标识无效")
		return
	}
	var in struct {
		Body     *string `json:"body"`
		Resolved *bool   `json:"resolved"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Body == nil && in.Resolved == nil {
		httpx.Error(w, http.StatusBadRequest, "empty_patch", "未指定需要修改的内容")
		return
	}
	if in.Body != nil && !validSlidesCommentText(*in.Body) {
		httpx.Error(w, http.StatusBadRequest, "invalid_body", "评论内容需为 1-2000 字")
		return
	}
	cm, err := st.UpdateSlidesCommentGuarded(r.Context(), g, id, cid, in.Body, in.Resolved)
	if driveWriteErr(w, err, "patch slides comment") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"comment": cm})
}

func (s *Server) deleteSlidesComment(w http.ResponseWriter, r *http.Request) {
	_, g, id, st, ok := s.slidesExtrasGuard(w, r)
	if !ok {
		return
	}
	cid, err := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	if err != nil || cid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "评论标识无效")
		return
	}
	if err := st.DeleteSlidesCommentGuarded(r.Context(), g, id, cid); driveWriteErr(w, err, "delete slides comment") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listSlidesVersions(w http.ResponseWriter, r *http.Request) {
	_, g, id, st, ok := s.slidesExtrasGuard(w, r)
	if !ok {
		return
	}
	versions, err := st.ListSlidesVersions(r.Context(), g, id)
	if driveWriteErr(w, err, "list slides versions") {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"versions": versions})
}

func (s *Server) createSlidesVersion(w http.ResponseWriter, r *http.Request) {
	u, g, id, st, ok := s.slidesExtrasGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		Label string `json:"label"`
	}
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	if !validSlidesVersionLabel(in.Label) {
		httpx.Error(w, http.StatusBadRequest, "invalid_label", "版本名称不能超过 120 字")
		return
	}
	version, err := st.CreateSlidesVersionGuarded(r.Context(), g, id, in.Label, false)
	if driveWriteErr(w, err, "create slides version") {
		return
	}
	var wsID int64
	if meta, metaErr := s.Store.GetDocSystem(r.Context(), id); metaErr == nil {
		wsID = meta.WorkspaceID
	} else if meta, metaErr := s.Store.GetDoc(r.Context(), u.ID, id); metaErr == nil {
		wsID = meta.WorkspaceID
	}
	if wsID > 0 {
		s.dispatchWorkspaceEvent(wsID, store.WebhookEventSlidesVersionCreated, map[string]any{
			"slidesId":  id,
			"versionId": version.ID,
			"name":      version.Label,
			"actorId":   u.ID,
		})
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusCreated, map[string]any{"version": version})
}

func (s *Server) restoreSlidesVersion(w http.ResponseWriter, r *http.Request) {
	u, g, id, st, ok := s.slidesExtrasGuard(w, r)
	if !ok {
		return
	}
	vid, err := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	if err != nil || vid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "版本标识无效")
		return
	}
	pages, err := st.RestoreSlidesVersionGuarded(r.Context(), g, id, vid)
	if driveWriteErr(w, err, "restore slides version") {
		return
	}
	s.notifySlides(id, u.ID)
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"pages": pages})
}
