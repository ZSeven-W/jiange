package api

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type safeLink struct {
	target    baseReadable
	available bool
	links     map[int64][]int64
}

type baseReverse struct {
	SourceBase int64             `json:"sourceBase"`
	FieldID    int64             `json:"fieldId"`
	From       map[int64][]int64 `json:"from"`
	Titles     map[int64]string  `json:"titles"`
}

// expandBase only traverses visible source rows/fields and targets that the
// same user can access. IDs and titles of restricted target rows are omitted.
func (s *Server) expandBase(ctx context.Context, uid int64, source *baseReadable, withExpansions bool) (map[string]any, []baseReadable, error) {
	expansions := map[string]any{}
	reads := []baseReadable{}
	cache := map[int64]baseReadable{}
	unavailable := map[int64]bool{}
	getTarget := func(id int64) (baseReadable, bool, error) {
		if id <= 0 || unavailable[id] {
			return baseReadable{}, false, nil
		}
		if id == source.meta.ID {
			return *source, true, nil
		}
		if cached, ok := cache[id]; ok {
			return cached, true, nil
		}
		t, err := s.readBaseAllowed(ctx, uid, id)
		if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
			unavailable[id] = true
			return baseReadable{}, false, nil
		}
		if err != nil {
			return baseReadable{}, false, err
		}
		cache[id] = t
		reads = append(reads, t)
		return t, true, nil
	}
	var srcIDs []int64
	for _, rec := range source.records {
		srcIDs = append(srcIDs, rec.ID)
	}
	linksByField := map[int64]safeLink{}
	for _, f := range source.fields {
		if f.Type != "link" {
			continue
		}
		var targetID int64
		if len(f.Options) > 0 {
			targetID, _ = strconv.ParseInt(f.Options[0], 10, 64)
		}
		target, ok, err := getTarget(targetID)
		if err != nil {
			return nil, nil, err
		}
		links := map[int64][]int64{}
		if ok && len(srcIDs) > 0 {
			raw, err := s.Store.LinksForRecords(ctx, f.ID, srcIDs)
			if err != nil {
				return nil, nil, err
			}
			allowed := map[int64]bool{}
			for _, r := range target.records {
				allowed[r.ID] = true
			}
			for from, tos := range raw {
				for _, to := range tos {
					if allowed[to] {
						links[from] = append(links[from], to)
					}
				}
			}
		}
		key := strconv.FormatInt(f.ID, 10)
		// The link IDs are also cached in the record's cells. Never return raw
		// IDs pointing to inaccessible targets or restricted target rows.
		for i := range source.records {
			if _, exists := source.records[i].Cells[key]; exists || len(links[source.records[i].ID]) > 0 {
				ids := links[source.records[i].ID]
				if ids == nil {
					ids = []int64{}
				}
				raw, _ := json.Marshal(ids)
				source.records[i].Cells[key] = raw
			}
		}
		titles := map[int64]string{}
		if ok {
			var titleField int64
			for _, tf := range target.fields {
				if tf.Type == "text" {
					titleField = tf.ID
					break
				}
			}
			used := map[int64]bool{}
			for _, tos := range links {
				for _, to := range tos {
					used[to] = true
				}
			}
			for _, rec := range target.records {
				if !used[rec.ID] || titleField == 0 {
					continue
				}
				var title string
				if json.Unmarshal(rec.Cells[strconv.FormatInt(titleField, 10)], &title) == nil {
					titles[rec.ID] = title
				}
			}
		}
		expansions[key] = links
		expansions[key+":titles"] = titles
		linksByField[f.ID] = safeLink{target: target, available: ok, links: links}
		if !ok {
			for i := range source.fields {
				if source.fields[i].ID == f.ID {
					source.fields[i].Options = nil
				}
			}
		}
	}
	if !withExpansions {
		return expansions, reads, nil
	}
	for _, f := range source.fields {
		if f.Type != "lookup" || len(f.Options) < 2 {
			continue
		}
		linkID, _ := strconv.ParseInt(f.Options[0], 10, 64)
		targetFieldID, _ := strconv.ParseInt(f.Options[1], 10, 64)
		link, ok := linksByField[linkID]
		if !ok || !link.available {
			for i := range source.fields {
				if source.fields[i].ID == f.ID {
					source.fields[i].Options = nil
				}
			}
			continue
		}
		visible := false
		for _, tf := range link.target.fields {
			if tf.ID == targetFieldID {
				visible = true
				break
			}
		}
		if !visible {
			for i := range source.fields {
				if source.fields[i].ID == f.ID {
					source.fields[i].Options = nil
				}
			}
			continue
		}
		byID := map[int64]store.Record{}
		for _, r := range link.target.records {
			byID[r.ID] = r
		}
		values := map[int64][]any{}
		for from, tos := range link.links {
			for _, to := range tos {
				var v any
				if raw, found := byID[to].Cells[strconv.FormatInt(targetFieldID, 10)]; found && json.Unmarshal(raw, &v) == nil {
					values[from] = append(values[from], v)
				}
			}
		}
		expansions[strconv.FormatInt(f.ID, 10)] = values
	}
	// Reverse references must be constructed from accessible source rows, not
	// all records in a source base whose name happens to be known.
	reverse, err := s.Store.LinkFieldsTargeting(ctx, source.meta.ID)
	if err != nil {
		return nil, nil, err
	}
	var result []baseReverse
	self := map[int64]bool{}
	for _, r := range source.records {
		self[r.ID] = true
	}
	for _, ref := range reverse {
		other, ok, err := getTarget(ref.BaseID)
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			continue
		}
		var fieldVisible bool
		var titleID int64
		for _, f := range other.fields {
			if f.ID == ref.FieldID && f.Type == "link" {
				fieldVisible = true
			}
			if titleID == 0 && f.Type == "text" {
				titleID = f.ID
			}
		}
		if !fieldVisible {
			continue
		}
		var ids []int64
		for _, rec := range other.records {
			ids = append(ids, rec.ID)
		}
		if len(ids) == 0 {
			continue
		}
		raw, err := s.Store.LinksForRecords(ctx, ref.FieldID, ids)
		if err != nil {
			return nil, nil, err
		}
		from := map[int64][]int64{}
		used := map[int64]bool{}
		for sourceID, tos := range raw {
			for _, to := range tos {
				if self[to] {
					from[to] = append(from[to], sourceID)
					used[sourceID] = true
				}
			}
		}
		if len(from) == 0 {
			continue
		}
		titles := map[int64]string{}
		for _, rec := range other.records {
			if !used[rec.ID] || titleID == 0 {
				continue
			}
			var title string
			if json.Unmarshal(rec.Cells[strconv.FormatInt(titleID, 10)], &title) == nil {
				titles[rec.ID] = title
			}
		}
		result = append(result, baseReverse{SourceBase: ref.BaseID, FieldID: ref.FieldID, From: from, Titles: titles})
	}
	if result == nil {
		result = []baseReverse{}
	}
	expansions["reverse"] = result
	return expansions, reads, nil
}
