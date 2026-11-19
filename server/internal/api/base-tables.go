package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func queryTableID(r *http.Request) int64 {
	raw := strings.TrimSpace(r.URL.Query().Get("tableId"))
	if raw == "" {
		return 0
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return -1
	}
	return id
}

func filterFieldsByTable(fields []store.Field, tableID int64) []store.Field {
	if tableID <= 0 {
		return fields
	}
	out := make([]store.Field, 0, len(fields))
	for _, f := range fields {
		if f.TableID == 0 || f.TableID == tableID {
			out = append(out, f)
		}
	}
	return out
}

func filterViewsByTable(views []store.View, tableID int64) []store.View {
	if tableID <= 0 {
		return views
	}
	out := make([]store.View, 0, len(views))
	for _, v := range views {
		if v.TableID == 0 || v.TableID == tableID {
			out = append(out, v)
		}
	}
	return out
}

func (s *Server) listBaseTables(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleView)
	if !ok {
		return
	}
	tables, err := s.Store.BaseTables(r.Context(), b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"tables": tables})
}

func (s *Server) createBaseTable(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = "数据表"
	}
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > 100 {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "数据表名称需为 1-100 个字符")
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	tbl, err := s.Store.CreateBaseTableGuarded(r.Context(), guard, b.ID, name)
	if err != nil {
		s.baseTableMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	httpx.JSON(w, http.StatusCreated, tbl)
}

func (s *Server) renameBaseTable(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > 100 {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "数据表名称需为 1-100 个字符")
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	tbl, err := s.Store.RenameBaseTableGuarded(r.Context(), guard, b.ID, pathID(r, "tid"), name)
	if err != nil {
		s.baseTableMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	httpx.JSON(w, http.StatusOK, tbl)
}

func (s *Server) deleteBaseTable(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	if err := s.Store.DeleteBaseTableGuarded(r.Context(), guard, b.ID, pathID(r, "tid")); err != nil {
		s.baseTableMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) reorderBaseTables(w http.ResponseWriter, r *http.Request) {
	b, ok := s.needBase(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if !s.allowBaseWrite(w, r, b) {
		return
	}
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	tables, err := s.Store.ReorderBaseTablesGuarded(r.Context(), guard, b.ID, in.IDs)
	if err != nil {
		s.baseTableMutationError(w, r, err)
		return
	}
	if s.BtHub != nil {
		s.BtHub.Notify(b.ID)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"tables": tables})
}

func (s *Server) baseTableMutationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限无法修改数据表")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "数据表不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "table_conflict", "默认数据表不可删除，或数据表列表已变化")
	default:
		s.fail(w, r, err)
	}
}
