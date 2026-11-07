package api

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

// readProjectionPolicy obtains only the metadata needed to authorize a
// targeted record lookup. It does not inherit the 10k list-page limit.
func (s *Server) readProjectionPolicy(ctx context.Context, userID, baseID int64) (baseReadable, error) {
	meta, err := s.Store.GetDoc(ctx, userID, baseID)
	if err != nil {
		return baseReadable{}, err
	}
	if meta.Kind != "base" || store.RoleRank(meta.Role) < store.RoleRank(store.RoleView) {
		return baseReadable{}, store.ErrNotFound
	}
	fields, err := s.Store.Fields(ctx, baseID)
	if err != nil {
		return baseReadable{}, err
	}
	views, err := s.Store.Views(ctx, baseID)
	if err != nil {
		return baseReadable{}, err
	}
	policy, err := parseBasePolicy(meta, fields, views)
	if err != nil {
		return baseReadable{}, err
	}
	return baseReadable{meta: meta, allFields: fields, fields: visibleBaseFields(fields, policy), views: views, policy: policy}, nil
}

// projectRecordLinks replaces cached link IDs with exactly those visible to
// the caller. Each target is checked by ID, including self-links and records
// outside the target's first list page; target policies are rechecked by the
// caller before returning the response.
func (s *Server) projectRecordLinks(ctx context.Context, userID int64, source *baseReadable) ([]baseReadable, error) {
	if len(source.records) != 1 {
		return nil, store.ErrConflict
	}
	targets := map[int64]baseReadable{}
	missing := map[int64]bool{}
	var checks []baseReadable
	for _, field := range source.fields {
		if field.Type != "link" {
			continue
		}
		key := strconv.FormatInt(field.ID, 10)
		links, err := s.Store.LinksForRecords(ctx, field.ID, []int64{source.records[0].ID})
		if err != nil {
			return nil, err
		}
		raw := links[source.records[0].ID]
		_, exists := source.records[0].Cells[key]
		if len(raw) == 0 && !exists {
			continue
		}
		var targetID int64
		if len(field.Options) > 0 {
			targetID, _ = strconv.ParseInt(field.Options[0], 10, 64)
		}
		visible := []int64{}
		if targetID > 0 && !missing[targetID] {
			target, ok := targets[targetID]
			if targetID == source.meta.ID {
				target = *source
				ok = true
			}
			if !ok {
				target, err = s.readProjectionPolicy(ctx, userID, targetID)
				if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
					missing[targetID] = true
					err = nil
				} else if err != nil {
					return nil, err
				} else {
					targets[targetID] = target
					checks = append(checks, target)
					ok = true
				}
			}
			if ok {
				visible, err = s.Store.VisibleRecordIDs(ctx, targetID, raw, target.allFields, target.policy.mandatory)
				if err != nil {
					return nil, err
				}
			}
		}
		encoded, err := json.Marshal(visible)
		if err != nil {
			return nil, err
		}
		source.records[0].Cells[key] = encoded
	}
	return checks, nil
}
