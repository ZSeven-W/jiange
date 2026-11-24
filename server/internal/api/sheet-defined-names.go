package api

import (
	"errors"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func (s *Server) sheetDefinedNamesStore(w http.ResponseWriter) (store.SheetDefinedNamesStore, bool) {
	ds, ok := s.Store.(store.SheetDefinedNamesStore)
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_supported", "当前存储不支持表格名称管理器")
		return nil, false
	}
	return ds, true
}

func (s *Server) getSheetDefinedNames(w http.ResponseWriter, r *http.Request) {
	_, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	ds, ok := s.sheetDefinedNamesStore(w)
	if !ok {
		return
	}
	names, err := ds.GetSheetDefinedNames(r.Context(), g, id)
	if driveWriteErr(w, err, "get sheet defined names") {
		return
	}
	if names == nil {
		names = []store.SheetDefinedName{}
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"definedNames": names})
}

func (s *Server) putSheetDefinedNames(w http.ResponseWriter, r *http.Request) {
	u, g, id, ok := s.sheetRequestGuard(w, r)
	if !ok {
		return
	}
	ds, ok := s.sheetDefinedNamesStore(w)
	if !ok {
		return
	}
	var in struct {
		DefinedNames []store.SheetDefinedName `json:"definedNames"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.DefinedNames == nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_defined_names", "定义名称列表不能为空")
		return
	}
	saved, err := ds.SaveSheetDefinedNamesGuarded(r.Context(), g, id, in.DefinedNames)
	if errors.Is(err, store.ErrInvalidSheetDefinedName) {
		httpx.Error(w, http.StatusBadRequest, "invalid_defined_names", "定义名称格式、作用域或数量无效")
		return
	}
	if driveWriteErr(w, err, "save sheet defined names") {
		return
	}
	if saved == nil {
		saved = []store.SheetDefinedName{}
	}
	if s.SheetHub != nil {
		if rev, headErr := s.Store.SheetHead(r.Context(), id); headErr == nil {
			s.SheetHub.Notify(id, rev, u.ID)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"definedNames": saved})
}
