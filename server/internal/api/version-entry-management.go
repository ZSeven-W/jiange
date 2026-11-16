package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type versionEntryManager interface {
	ManageVersionEntry(context.Context, store.RestoreGuard, int64, string, int64, *string) error
}

type versionEntryTrash interface {
	DeletedVersionEntries(context.Context, store.RestoreGuard, int64) ([]store.DeletedVersionEntry, error)
	RestoreVersionEntry(context.Context, store.RestoreGuard, int64, string, int64) error
}

func (s *Server) listDeletedVersionEntries(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	d, guard, _, ok := s.versionEntryAccess(w, r, store.RoleEdit)
	if !ok {
		return
	}
	manager, ok := s.Store.(versionEntryTrash)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "版本回收站不可用")
		return
	}
	entries, err := manager.DeletedVersionEntries(r.Context(), guard, d.ID)
	if err != nil {
		s.versionReadError(w, r, err)
		return
	}
	role, err := s.versionReadRole(r.Context(), guard, d.ID)
	if err != nil {
		s.versionReadError(w, r, err)
		return
	}
	if store.RoleRank(role) < store.RoleRank(store.RoleEdit) {
		httpx.Error(w, http.StatusNotFound, "not_found", "版本不存在或无权访问")
		return
	}
	if entries == nil {
		entries = []store.DeletedVersionEntry{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"versions": entries})
}

func (s *Server) manageSavedVersionEntry(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	id := r.PathValue("entry")
	if !validSavedVersionID(id) {
		httpx.Error(w, http.StatusNotFound, "not_found", "版本不存在或无权访问")
		return
	}
	d, guard, _, ok := s.versionEntryAccess(w, r, store.RoleEdit)
	if !ok {
		return
	}
	var in struct {
		Action           string  `json:"action"`
		ExpectedRevision int64   `json:"expectedRevision"`
		Label            *string `json:"label"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedRevision <= 0 || in.ExpectedRevision > 1<<53-1 || (in.Action != "rename" && in.Action != "delete" && in.Action != "restore") || (in.Action == "rename") != (in.Label != nil) {
		httpx.Error(w, http.StatusBadRequest, "invalid_request", "版本操作无效")
		return
	}
	if in.Label != nil {
		name := strings.TrimSpace(*in.Label)
		if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > 1000 {
			httpx.Error(w, http.StatusBadRequest, "invalid_label", "版本名称无效")
			return
		}
		in.Label = &name
	}
	var err error
	if in.Action == "restore" {
		manager, available := s.Store.(versionEntryTrash)
		if !available {
			httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "版本回收站不可用")
			return
		}
		err = manager.RestoreVersionEntry(r.Context(), guard, d.ID, id, in.ExpectedRevision)
	} else {
		manager, available := s.Store.(versionEntryManager)
		if !available {
			httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "版本服务不可用")
			return
		}
		err = manager.ManageVersionEntry(r.Context(), guard, d.ID, id, in.ExpectedRevision, in.Label)
	}
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "version_conflict", "版本已变化，请刷新后重试")
		return
	}
	if err != nil {
		s.versionReadError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
