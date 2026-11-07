package api

import (
	"errors"
	"io"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) docCoverError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden), errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前没有所需权限或图片不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "cover_conflict", "封面已发生变化，请刷新后重试")
	default:
		s.fail(w, r, err)
	}
}

func (s *Server) getDocCover(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	result, err := s.Store.DocCoverGuarded(r.Context(), guard, d.ID)
	if err != nil {
		s.docCoverError(w, r, err)
		return
	}
	current, docErr := s.Store.GetDoc(r.Context(), guard.UserID, d.ID)
	user, sessionErr := s.Store.SessionUser(r.Context(), guard.SessionHash, s.now())
	if docErr != nil || store.RoleRank(current.Role) < store.RoleRank(store.RoleView) || sessionErr != nil || user.ID != guard.UserID {
		httpx.Error(w, http.StatusForbidden, "forbidden", "文档权限已变化")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, result)
}

func (s *Server) putDocCover(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in struct {
		Kind             *string  `json:"kind"`
		Asset            string   `json:"asset"`
		FileID           int64    `json:"fileId"`
		Position         *float64 `json:"position"`
		ExpectedRevision *int64   `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Kind == nil || in.Position == nil || in.ExpectedRevision == nil || *in.ExpectedRevision < 0 || *in.ExpectedRevision >= 9007199254740991 {
		httpx.Error(w, http.StatusBadRequest, "invalid_cover", "无效的封面或版本")
		return
	}
	cover := store.DocCover{Kind: *in.Kind, Asset: in.Asset, FileID: in.FileID, Position: *in.Position}
	if !store.ValidDocCover(cover) {
		httpx.Error(w, http.StatusBadRequest, "invalid_cover", "无效的封面或位置")
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	if cover.Kind == "file" {
		if s.Blobs == nil {
			httpx.Error(w, http.StatusServiceUnavailable, "no_storage", "附件存储不可用")
			return
		}
		file, err := s.Store.GetFile(r.Context(), cover.FileID)
		if err != nil || file.DocID != d.ID || file.Size < 1 || file.Size > maxUpload {
			httpx.Error(w, http.StatusBadRequest, "invalid_cover", "封面图片不存在或不属于此文档")
			return
		}
		release, available := acquireCoverDecode(w)
		if !available {
			return
		}
		defer release()
		rc, err := s.Blobs.Get(r.Context(), file.ObjectKey)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		body, readErr := io.ReadAll(io.LimitReader(rc, maxUpload+1))
		closeErr := rc.Close()
		if readErr != nil || closeErr != nil {
			httpx.Error(w, http.StatusServiceUnavailable, "cover_unavailable", "封面图片读取失败")
			return
		}
		if int64(len(body)) != file.Size || validateCoverImage(body, file.Mime) != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_cover", "封面仅支持有效的 JPG、PNG 或 GIF 图片")
			return
		}
	}
	result, err := s.Store.SetDocCoverGuarded(r.Context(), guard, d.ID, cover, *in.ExpectedRevision)
	if err != nil {
		s.docCoverError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	current, docErr := s.Store.GetDoc(r.Context(), guard.UserID, d.ID)
	user, sessionErr := s.Store.SessionUser(r.Context(), guard.SessionHash, s.now())
	if docErr != nil || store.RoleRank(current.Role) < store.RoleRank(store.RoleView) || sessionErr != nil || user.ID != guard.UserID {
		w.Header().Set("X-Cover-Refresh-Required", "true")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}
