package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// Bound concurrent materializations: the synchronous CRDT decoder cannot be
// forcibly interrupted by a context deadline.
var titleCheckSlots = make(chan struct{}, 1)

func materializeTitle(ctx context.Context, snapshot store.TitleSnapshot) (string, error) {
	doc := collab.NewDoc()
	if len(snapshot.Snapshot) != 0 {
		var err error
		doc, err = collab.DecodeState(snapshot.Snapshot)
		if err != nil {
			return "", fmt.Errorf("invalid document snapshot: %w", err)
		}
	}
	seq := snapshot.SnapshotSeq
	for _, row := range snapshot.Ops {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if row.Seq != seq+1 || row.Seq > snapshot.Head {
			return "", fmt.Errorf("incomplete document log")
		}
		ops, err := collab.DecodeOps(row.Bytes)
		if err != nil || len(ops) != 1 || row.ClientID < 0 || (len(ops) == 1 && uint64(row.ClientID) != ops[0].ID.Client) {
			return "", fmt.Errorf("invalid document operation at sequence %d", row.Seq)
		}
		if !doc.Apply(ops[0]) {
			return "", fmt.Errorf("duplicate document operation at sequence %d", row.Seq)
		}
		seq = row.Seq
	}
	if seq != snapshot.Head || doc.Pending() != 0 || snapshot.Head > 9007199254740991 {
		return "", fmt.Errorf("incomplete or incompatible document state")
	}
	title, kind, visible := doc.VisibleBlockText(collab.OpID{Client: 0, Clock: 1})
	if !visible || kind != "title" {
		return "", fmt.Errorf("document title block missing or hidden")
	}
	return title, nil
}

// getTitleConsistency compares the two existing title sources at one storage
// snapshot. It never attempts to pick a winner or modify either source.
func (s *Server) getTitleConsistency(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	meta, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	if meta.Kind != "doc" {
		httpx.Error(w, http.StatusBadRequest, "invalid_kind", "仅文档支持标题一致性检查")
		return
	}
	select {
	case titleCheckSlots <- struct{}{}:
		defer func() { <-titleCheckSlots }()
	default:
		httpx.Error(w, http.StatusServiceUnavailable, "title_check_busy", "标题检查繁忙，请稍后重试")
		return
	}
	epoch, head, err := s.Store.HeadVersion(r.Context(), meta.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	snapshot, err := s.Store.ReadTitleSnapshot(r.Context(), meta.ID)
	if errors.Is(err, store.ErrTitleSnapshotTooLarge) {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "title_check_too_large", "文档内容过大，暂无法检查标题")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	title, err := materializeTitle(r.Context(), snapshot)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	endEpoch, endHead, err := s.Store.HeadVersion(r.Context(), meta.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if epoch < 1 || epoch > conditionalSafeInteger || head != snapshot.Head || endEpoch != epoch || endHead != head {
		httpx.Error(w, http.StatusConflict, "title_changed", "文档已变化，请重新检查")
		return
	}
	// Revalidate the original session as well as the document grant. A user
	// may have logged out while reconstruction was in progress.
	u, _ := UserFrom(r.Context())
	cookie, err := r.Cookie(CookieName)
	if err != nil || cookie.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "session expired")
		return
	}
	current, err := s.Store.SessionUser(r.Context(), auth.HashToken(cookie.Value), s.now())
	if err != nil || current.ID != u.ID {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "session expired")
		return
	}
	// Access may have been revoked while the state was reconstructed.
	if _, ok := s.need(w, r, store.RoleView); !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"directoryTitle": snapshot.DirectoryTitle, "documentTitle": title,
		"head": snapshot.Head, "historyEpoch": epoch, "differs": snapshot.DirectoryTitle != title,
	})
}
