package api

import (
	"net/http"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
)

// Slides pages: guarded mutations (session revalidation + edit access on the
// owning slides node), mirroring the drive endpoints' error mapping.

func (s *Server) postSlidesPage(w http.ResponseWriter, r *http.Request) {
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		Title string `json:"title"`
	}
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	if n := len([]rune(in.Title)); n > 200 {
		httpx.Error(w, http.StatusBadRequest, "invalid_title", "标题不能超过 200 字")
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "slides id required")
		return
	}
	page, err := s.Store.CreateSlidesPage(r.Context(), g, id, in.Title)
	if driveWriteErr(w, err, "create page") {
		return
	}
	httpx.JSON(w, http.StatusCreated, page)
}

func (s *Server) listSlidesPages(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "slides id required")
		return
	}
	pages, err := s.Store.ListSlidesPages(r.Context(), u.ID, id)
	if driveWriteErr(w, err, "list pages") {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"pages": pages})
}

func (s *Server) patchSlidesPage(w http.ResponseWriter, r *http.Request) {
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		Title      string `json:"title"`
		Body       string `json:"body"`
		Background string `json:"background"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if n := len([]rune(in.Title)); n > 200 {
		httpx.Error(w, http.StatusBadRequest, "invalid_title", "标题不能超过 200 字")
		return
	}
	if len(in.Body) > 20000 || len(in.Background) > 200 {
		httpx.Error(w, http.StatusBadRequest, "invalid_body", "内容超出限制")
		return
	}
	pid, err := strconv.ParseInt(r.PathValue("pid"), 10, 64)
	if err != nil || pid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "page id required")
		return
	}
	page, err := s.Store.UpdateSlidesPage(r.Context(), g, pid, in.Title, in.Body, in.Background)
	if driveWriteErr(w, err, "update page") {
		return
	}
	httpx.JSON(w, http.StatusOK, page)
}

func (s *Server) deleteSlidesPage(w http.ResponseWriter, r *http.Request) {
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	pid, err := strconv.ParseInt(r.PathValue("pid"), 10, 64)
	if err != nil || pid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "page id required")
		return
	}
	if driveWriteErr(w, s.Store.DeleteSlidesPage(r.Context(), g, pid), "delete page") {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) moveSlidesPage(w http.ResponseWriter, r *http.Request) {
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	var in struct {
		Pos float64 `json:"pos"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	pid, err := strconv.ParseInt(r.PathValue("pid"), 10, 64)
	if err != nil || pid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "page id required")
		return
	}
	if driveWriteErr(w, s.Store.MoveSlidesPage(r.Context(), g, pid, in.Pos), "move page") {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
