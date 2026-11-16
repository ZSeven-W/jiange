package api

import (
	"context"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

var savedVersionID = regexp.MustCompile(`^[ns]:[1-9][0-9]{0,15}$`)

func validSavedVersionID(id string) bool {
	if !savedVersionID.MatchString(id) {
		return false
	}
	_, raw, _ := strings.Cut(id, ":")
	n, err := strconv.ParseUint(raw, 10, 53)
	return err == nil && n > 0
}

func savedVersionByID(ctx context.Context, st versionEntryStore, guard store.RestoreGuard, docID int64, id string) (store.VersionEntry, error) {
	entries, err := st.ListVersionEntries(ctx, guard, docID)
	if err != nil {
		return store.VersionEntry{}, err
	}
	for _, entry := range entries {
		if entry.ID == id && entry.CreatedBy > 0 {
			return entry, nil
		}
	}
	return store.VersionEntry{}, store.ErrNotFound
}

// A version link identifies a saved entry, not just a sequence that another
// entry may happen to share. It never grants document access by itself.
func (s *Server) getSavedVersionEntry(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	id := r.PathValue("entry")
	if !validSavedVersionID(id) {
		httpx.Error(w, http.StatusNotFound, "not_found", "版本不存在或无权访问")
		return
	}
	d, guard, st, ok := s.versionEntryAccess(w, r, store.RoleView)
	if !ok {
		return
	}
	entry, err := savedVersionByID(r.Context(), st, guard, d.ID, id)
	if err != nil {
		s.versionReadError(w, r, err)
		return
	}
	state, err := s.Store.VersionState(r.Context(), d.ID, entry.Seq)
	if err != nil {
		s.versionReadError(w, r, err)
		return
	}
	doc, err := collab.DecodeState(state)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	view := doc.View()
	projected, projectionErr := publicTableView(view)
	current, err := savedVersionByID(r.Context(), st, guard, d.ID, id)
	if err != nil {
		s.versionReadError(w, r, err)
		return
	}
	if current.Seq != entry.Seq || current.CreatedBy != entry.CreatedBy {
		httpx.Error(w, http.StatusConflict, "version_access_changed", "版本已变化，请重试")
		return
	}
	role, err := s.versionReadRole(r.Context(), guard, d.ID)
	if err != nil {
		s.versionReadError(w, r, err)
		return
	}
	if rejectUnsupportedTableView(w, doc) {
		return
	}
	if store.RoleRank(role) < store.RoleRank(store.RoleEdit) {
		if projectionErr != nil {
			httpx.Error(w, http.StatusConflict, "table_unavailable", "表格数据暂无法安全显示，请联系文档所有者")
			return
		}
		view = projected
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": current.ID, "seq": current.Seq, "view": view})
}
