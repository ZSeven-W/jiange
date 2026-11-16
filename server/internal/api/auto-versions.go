package api

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type AutomaticVersionStore interface {
	store.DocStore
	AutoVersionCandidates(context.Context, int64, int) ([]store.AutoVersionCandidate, error)
	SaveAutomaticVersion(context.Context, store.AutoVersionCandidate, []byte) (bool, error)
}

// SweepAutomaticVersions snapshots all eligible current heads, not only edits
// in a recent time window. A raced or failed document is revisited next sweep.
func SweepAutomaticVersions(ctx context.Context, st AutomaticVersionStore, log *slog.Logger) (int, error) {
	if log == nil {
		log = slog.Default()
	}
	var after int64
	created := 0
	for {
		pageCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		candidates, err := st.AutoVersionCandidates(pageCtx, after, 100)
		cancel()
		if err != nil {
			return created, err
		}
		if len(candidates) == 0 {
			return created, nil
		}
		for _, candidate := range candidates {
			if err = ctx.Err(); err != nil {
				return created, err
			}
			after = candidate.DocID
			func() {
				itemCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				defer cancel()
				doc, head, e := StateAtHead(itemCtx, st, candidate.DocID)
				if e == nil && head != candidate.Head {
					e = store.ErrConflict
				}
				if e == nil {
					var saved bool
					saved, e = st.SaveAutomaticVersion(itemCtx, candidate, doc.EncodeState())
					if saved && e == nil {
						created++
					}
				}
				if e != nil && !errors.Is(e, store.ErrConflict) && !errors.Is(e, store.ErrNotFound) {
					log.Warn("automatic version deferred", "doc", candidate.DocID, "error", e)
				}
			}()
		}
	}
}
