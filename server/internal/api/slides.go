package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"unicode/utf8"

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
		Title            string           `json:"title"`
		Body             string           `json:"body"`
		Background       string           `json:"background"`
		Notes            *string          `json:"notes"`
		Shapes           *json.RawMessage `json:"shapes"`
		ExpectedRevision int64            `json:"expectedRevision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if n := len([]rune(in.Title)); n > 200 {
		httpx.Error(w, http.StatusBadRequest, "invalid_title", "标题不能超过 200 字")
		return
	}
	if len(in.Body) > 20000 || len(in.Background) > 200 || (in.Notes != nil && len(*in.Notes) > 20000) {
		httpx.Error(w, http.StatusBadRequest, "invalid_body", "内容超出限制")
		return
	}
	if in.Shapes != nil && !validSlideShapes(*in.Shapes) {
		httpx.Error(w, http.StatusBadRequest, "invalid_shapes", "图形数据无效")
		return
	}
	pid, err := strconv.ParseInt(r.PathValue("pid"), 10, 64)
	if err != nil || pid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "page id required")
		return
	}
	page, err := s.Store.UpdateSlidesPage(r.Context(), g, pid, in.Title, in.Body, in.Background, in.Notes, in.Shapes, in.ExpectedRevision)
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

var slideShapeID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
var slideShapeColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func validSlideShapes(raw json.RawMessage) bool {
	if len(raw) > 800000 || len(raw) == 0 || raw[0] != '[' {
		return false
	}
	var shapes []struct {
		ID       string   `json:"id"`
		Kind     string   `json:"kind"`
		X        float64  `json:"x"`
		Y        float64  `json:"y"`
		Color    string   `json:"color"`
		Width    *float64 `json:"width"`
		Height   *float64 `json:"height"`
		Rotation *float64 `json:"rotation"`
		Text     *string  `json:"text"`
		FontSize *float64 `json:"fontSize"`
		Bold     *bool    `json:"bold"`
		Align    *string  `json:"align"`
	}
	if json.Unmarshal(raw, &shapes) != nil || len(shapes) > 100 {
		return false
	}
	seen := make(map[string]bool)
	for _, s := range shapes {
		width, height := 16.0, 20.0
		if s.Width != nil {
			width = *s.Width
		}
		if s.Height != nil {
			height = *s.Height
		}
		rotation := 0.0
		if s.Rotation != nil {
			rotation = *s.Rotation
		}
		if !slideShapeID.MatchString(s.ID) || seen[s.ID] || (s.Kind != "rectangle" && s.Kind != "ellipse" && s.Kind != "triangle" && s.Kind != "text") || !(width >= 5 && width <= 100 && height >= 5 && height <= 100 && s.X >= 0 && s.X+width <= 100 && s.Y >= 0 && s.Y+height <= 100 && rotation >= 0 && rotation <= 359) || !slideShapeColor.MatchString(s.Color) {
			return false
		}
		if s.Kind == "text" && (s.Text == nil || utf8.RuneCountInString(*s.Text) > 1000 || (s.FontSize != nil && (*s.FontSize < 12 || *s.FontSize > 96)) || (s.Align != nil && *s.Align != "left" && *s.Align != "center" && *s.Align != "right")) {
			return false
		}
		seen[s.ID] = true
	}
	return true
}
