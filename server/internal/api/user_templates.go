package api

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const maxTemplateBody = 200 << 10

func (s *Server) listUserTemplates(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	list, err := s.Store.UserTemplates(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"templates": list})
}

func (s *Server) addUserTemplate(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	var in struct {
		Name string `json:"name"`
		Body string `json:"body"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	name := strings.TrimSpace(in.Name)
	if n := utf8.RuneCountInString(name); n == 0 || n > 100 {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "模板名称需为 1-100 字")
		return
	}
	if strings.TrimSpace(in.Body) == "" || len(in.Body) > maxTemplateBody || !utf8.ValidString(in.Body) {
		httpx.Error(w, http.StatusBadRequest, "invalid_body", "模板内容为空或超过 200KB")
		return
	}
	t, err := s.Store.AddUserTemplate(r.Context(), u.ID, name, in.Body)
	if errors.Is(err, store.ErrTooManyTemplates) {
		httpx.Error(w, http.StatusConflict, "too_many_templates", "最多保存 100 个模板，请先删除不用的模板")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, t)
}

func (s *Server) deleteUserTemplate(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	if err := s.Store.DeleteUserTemplate(r.Context(), u.ID, pathID(r, "tid")); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "模板不存在")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
