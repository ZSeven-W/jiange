package api

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
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
	s.notifySlides(id, g.UserID)
	httpx.JSON(w, http.StatusCreated, page)
}

func (s *Server) listSlidesPages(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	version := r.Header.Get("X-Jiange-Slides-Version")
	if version == "2" || version == "3" || version == "4" || version == "5" {
		if r.Header.Get("X-Jiange-User-Id") == "" {
			httpx.Error(w, http.StatusBadRequest, "missing_account", "查看账号未确认")
			return
		}
		if !driveExpectedUser(w, r, u.ID) {
			return
		}
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "slides id required")
		return
	}
	pages, err := s.Store.ListSlidesPages(r.Context(), u.ID, id)
	if driveWriteErr(w, err, "list pages") {
		return
	}
	for _, page := range pages {
		if (version != "2" && version != "3" && version != "4" && version != "5" && page.Hidden) || (version != "3" && version != "4" && version != "5" && page.Layout != "") || (version != "4" && version != "5" && store.HasModernSlideShapes(page.Shapes)) || (version != "5" && store.HasSlidesV5Shapes(page.Shapes)) {
			httpx.Error(w, http.StatusUpgradeRequired, "slide_client_outdated", "请刷新以使用支持当前页面的幻灯片编辑器")
			return
		}
	}
	protocol := 2
	if version == "3" {
		protocol = 3
	} else if version == "4" {
		protocol = 4
	} else if version == "5" {
		protocol = 5
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"pages": pages, "presentationProtocol": protocol})
}

func (s *Server) patchSlidesPage(w http.ResponseWriter, r *http.Request) {
	s.patchSlidesContent(w, r, false)
}
func (s *Server) patchSlidesPageV3(w http.ResponseWriter, r *http.Request) {
	s.patchSlidesContent(w, r, true)
}
func (s *Server) patchSlidesContent(w http.ResponseWriter, r *http.Request, v3 bool) {
	var deck int64
	if v3 {
		u, ok := UserFrom(r.Context())
		if !ok {
			httpx.Error(w, http.StatusUnauthorized, "unauthorized", "请重新登录")
			return
		}
		if r.Header.Get("X-Jiange-User-Id") == "" {
			httpx.Error(w, http.StatusBadRequest, "missing_account", "操作账号未确认")
			return
		}
		if !driveExpectedUser(w, r, u.ID) {
			return
		}
		var err error
		deck, err = strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || deck <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_id", "幻灯片标识无效")
			return
		}
	}
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
		Layout           *string          `json:"layout"`
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
	var page store.SlidesPage
	if v3 {
		if in.Layout == nil || !store.ValidSlideLayout(*in.Layout) {
			httpx.Error(w, http.StatusBadRequest, "invalid_layout", "页面布局无效")
			return
		}
		if r.Header.Get("X-Jiange-Slides-Version") == "5" {
			modern, ok := s.Store.(store.SlidesShapesV5Store)
			if !ok {
				httpx.Error(w, http.StatusUpgradeRequired, "slide_server_outdated", "请升级幻灯片服务")
				return
			}
			page, err = modern.UpdateSlidesPageV5(r.Context(), g, deck, pid, in.Title, in.Body, in.Background, *in.Layout, in.Notes, in.Shapes, in.ExpectedRevision)
		} else if r.Header.Get("X-Jiange-Slides-Version") == "4" {
			modern, ok := s.Store.(store.SlidesShapesV4Store)
			if !ok {
				httpx.Error(w, http.StatusUpgradeRequired, "slide_server_outdated", "请升级幻灯片服务")
				return
			}
			page, err = modern.UpdateSlidesPageV4(r.Context(), g, deck, pid, in.Title, in.Body, in.Background, *in.Layout, in.Notes, in.Shapes, in.ExpectedRevision)
		} else {
			page, err = s.Store.UpdateSlidesPageV3(r.Context(), g, deck, pid, in.Title, in.Body, in.Background, *in.Layout, in.Notes, in.Shapes, in.ExpectedRevision)
		}
	} else {
		page, err = s.Store.UpdateSlidesPage(r.Context(), g, pid, in.Title, in.Body, in.Background, in.Notes, in.Shapes, in.ExpectedRevision)
	}
	if errors.Is(err, store.ErrSlideClientOutdated) {
		httpx.Error(w, http.StatusUpgradeRequired, "slide_client_outdated", "请刷新以使用支持当前布局的幻灯片编辑器")
		return
	}
	if driveWriteErr(w, err, "update page") {
		return
	}
	s.notifySlides(page.SlidesID, g.UserID)
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

type slideShapeCrop struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

func validSafeSlideMediaURL(raw string, maxLen int) bool {
	if len(raw) == 0 {
		return true
	}
	if len(raw) > maxLen {
		return false
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] <= 0x20 || raw[i] == 0x7f {
			return false
		}
	}
	if strings.HasPrefix(raw, "/api/files/") {
		rest := raw[len("/api/files/"):]
		return len(rest) > 0 && !strings.Contains(rest, "..") && !strings.Contains(rest, "\\") && !strings.HasPrefix(rest, "/")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	if (scheme == "https" || scheme == "http") && u.Host != "" {
		return true
	}
	return false
}

func validSlideImageCrop(crop *slideShapeCrop) bool {
	if crop == nil {
		return true
	}
	if math.IsNaN(crop.X) || math.IsInf(crop.X, 0) ||
		math.IsNaN(crop.Y) || math.IsInf(crop.Y, 0) ||
		math.IsNaN(crop.W) || math.IsInf(crop.W, 0) ||
		math.IsNaN(crop.H) || math.IsInf(crop.H, 0) {
		return false
	}
	return crop.X >= 0 && crop.X < 1 &&
		crop.Y >= 0 && crop.Y < 1 &&
		crop.W > 0 && crop.W <= 1 &&
		crop.H > 0 && crop.H <= 1 &&
		crop.X+crop.W <= 1.001 &&
		crop.Y+crop.H <= 1.001
}

func validSlideShapes(raw json.RawMessage) bool {
	if len(raw) > 800000 || len(raw) == 0 || raw[0] != '[' {
		return false
	}
	var shapes []struct {
		ID        string          `json:"id"`
		Kind      string          `json:"kind"`
		X         float64         `json:"x"`
		Y         float64         `json:"y"`
		Color     string          `json:"color"`
		Width     *float64        `json:"width"`
		Height    *float64        `json:"height"`
		Rotation  *float64        `json:"rotation"`
		Text      *string         `json:"text"`
		FontSize  *float64        `json:"fontSize"`
		Bold      *bool           `json:"bold"`
		Align     *string         `json:"align"`
		FileID    *int64          `json:"fileId"`
		MediaURL  *string         `json:"mediaUrl"`
		PosterURL *string         `json:"posterUrl"`
		Autoplay  *bool           `json:"autoplay"`
		Loop      *bool           `json:"loop"`
		Crop      *slideShapeCrop `json:"crop"`
		Table     *struct {
			Rows        [][]string `json:"rows"`
			HeaderRow   *bool      `json:"headerRow"`
			HeaderFill  *string    `json:"headerFill"`
			BorderColor *string    `json:"borderColor"`
		} `json:"table"`
		Chart *struct {
			Type       string   `json:"type"`
			Title      string   `json:"title"`
			Categories []string `json:"categories"`
			Series     []struct {
				Name   string    `json:"name"`
				Values []float64 `json:"values"`
				Color  string    `json:"color"`
			} `json:"series"`
		} `json:"chart"`
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
		if !slideShapeID.MatchString(s.ID) || seen[s.ID] || (s.Kind != "rectangle" && s.Kind != "ellipse" && s.Kind != "triangle" && s.Kind != "rounded-rectangle" && s.Kind != "right-triangle" && s.Kind != "diamond" && s.Kind != "pentagon" && s.Kind != "hexagon" && s.Kind != "star" && s.Kind != "parallelogram" && s.Kind != "trapezoid" && s.Kind != "arrow-right" && s.Kind != "line" && s.Kind != "line-arrow" && s.Kind != "line-arrow-filled" && s.Kind != "line-dot" && s.Kind != "line-double-arrow" && s.Kind != "text" && s.Kind != "image" && s.Kind != "table" && s.Kind != "chart" && s.Kind != "video" && s.Kind != "audio") || !(width >= 5 && width <= 100 && height >= 5 && height <= 100 && s.X >= 0 && s.X+width <= 100 && s.Y >= 0 && s.Y+height <= 100 && rotation >= 0 && rotation <= 359) || !slideShapeColor.MatchString(s.Color) {
			return false
		}
		if s.Kind == "text" && (s.Text == nil || utf8.RuneCountInString(*s.Text) > 1000 || (s.FontSize != nil && (*s.FontSize < 12 || *s.FontSize > 96)) || (s.Align != nil && *s.Align != "left" && *s.Align != "center" && *s.Align != "right")) {
			return false
		}
		if s.Kind == "image" && (s.FileID == nil || *s.FileID <= 0) {
			return false
		}
		if s.Crop != nil && (s.Kind != "image" || !validSlideImageCrop(s.Crop)) {
			return false
		}
		if s.MediaURL != nil && !validSafeSlideMediaURL(*s.MediaURL, 2048) {
			return false
		}
		if s.PosterURL != nil && !validSafeSlideMediaURL(*s.PosterURL, 2048) {
			return false
		}
		if s.Kind == "table" {
			if s.Table == nil || len(s.Table.Rows) < 1 || len(s.Table.Rows) > 20 {
				return false
			}
			cols := len(s.Table.Rows[0])
			if cols < 1 || cols > 12 {
				return false
			}
			for _, row := range s.Table.Rows {
				if len(row) != cols {
					return false
				}
				for _, cell := range row {
					if utf8.RuneCountInString(cell) > 500 {
						return false
					}
				}
			}
		}
		if s.Kind == "chart" {
			if s.Chart == nil || (s.Chart.Type != "column" && s.Chart.Type != "bar" && s.Chart.Type != "line" && s.Chart.Type != "pie") || utf8.RuneCountInString(s.Chart.Title) > 120 || len(s.Chart.Categories) < 1 || len(s.Chart.Categories) > 24 || len(s.Chart.Series) < 1 || len(s.Chart.Series) > 8 {
				return false
			}
			for _, ser := range s.Chart.Series {
				if utf8.RuneCountInString(ser.Name) > 80 || len(ser.Values) > 24 {
					return false
				}
			}
		}
		seen[s.ID] = true
	}
	return true
}
