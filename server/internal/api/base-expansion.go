package api

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

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

// Only use fields present in the caller's authorized projection. Legacy or
// permission-filtered projections may not contain the primary field.
func visibleTitleField(fields, allFields []store.Field) *store.Field {
	for _, primary := range allFields {
		if !primary.IsPrimary {
			continue
		}
		for i := range fields {
			if fields[i].ID == primary.ID {
				return &fields[i]
			}
		}
		// A hidden primary field must not be replaced by some other visible
		// field and presented as the record's title.
		return nil
	}
	for i := range fields {
		if fields[i].Type == "text" {
			return &fields[i]
		}
	}
	return nil
}

// visibleTitleMemberIDs lists the member ids a person/created_by title field
// references; a multi-person cell contributes every id in stored order.
func visibleTitleMemberIDs(record store.Record, field *store.Field) []int64 {
	if field == nil {
		return nil
	}
	if field.Type == "created_by" {
		if record.CreatorID != nil && *record.CreatorID > 0 {
			return []int64{*record.CreatorID}
		}
		return nil
	}
	if field.Type != "person" {
		return nil
	}
	var v any
	if json.Unmarshal(record.Cells[strconv.FormatInt(field.ID, 10)], &v) != nil {
		return nil
	}
	switch x := v.(type) {
	case float64:
		if x > 0 {
			return []int64{int64(x)}
		}
	case []any:
		ids := make([]int64, 0, len(x))
		for _, item := range x {
			if n, ok := item.(float64); ok && n > 0 {
				ids = append(ids, int64(n))
			}
		}
		return ids
	}
	return nil
}

func visibleRecordTitle(record store.Record, field *store.Field, names map[int64]string) string {
	if field == nil {
		return ""
	}
	// IDs and stored formulas are not display names. Until the authorized
	// target-member and computed-field projection is available, do not leak an
	// internal identifier or claim a derived value is a record title.
	switch field.Type {
	case "person", "created_by":
		parts := make([]string, 0, 2)
		for _, id := range visibleTitleMemberIDs(record, field) {
			if name := names[id]; name != "" {
				parts = append(parts, name)
			}
		}
		return strings.Join(parts, "、")
	case "formula", "lookup", "link":
		return ""
	case "created_at":
		if record.CreatedAt != nil {
			return record.CreatedAt.Format("2006-01-02 15:04")
		}
		return ""
	case "modified_at":
		if record.UpdatedAt != nil {
			return record.UpdatedAt.Format("2006-01-02 15:04")
		}
		return ""
	}
	raw := record.Cells[strconv.FormatInt(field.ID, 10)]
	var value any
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return ""
	}
	switch v := value.(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	case bool:
		return strconv.FormatBool(v)
	case []any:
		var values []string
		for _, item := range v {
			if s, ok := item.(string); ok {
				values = append(values, s)
			}
		}
		return strings.Join(values, ", ")
	default:
		return ""
	}
}

// Only request directory names referenced by records already authorized in
// this snapshot. The result is rechecked before the response is sent.
func titleMemberNames(ctx context.Context, reader store.BaseSnapshotReader, table baseReadable, field *store.Field, used map[int64]bool) ([]int64, map[int64]string, error) {
	var ids []int64
	seen := map[int64]bool{}
	for _, record := range table.records {
		if !used[record.ID] {
			continue
		}
		for _, id := range visibleTitleMemberIDs(record, field) {
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}
	if len(ids) == 0 {
		return nil, nil, nil
	}
	names, err := reader.VisibleMemberNames(ctx, table.meta.WorkspaceID, ids)
	return ids, names, err
}

// expandBase only traverses visible source rows/fields and targets that the
// same user can access. IDs and titles of restricted target rows are omitted.
func (s *Server) expandBase(ctx context.Context, uid int64, source *baseReadable, withExpansions bool) (map[string]any, []baseReadable, error) {
	return expandBaseWith(ctx, s.Store, uid, source, withExpansions)
}

func expandBaseWith(ctx context.Context, reader store.BaseSnapshotReader, uid int64, source *baseReadable, withExpansions bool) (map[string]any, []baseReadable, error) {
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
		t, err := readBasePolicyWith(ctx, reader, uid, id)
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
			raw, err := reader.LinksForRecordsConstrained(ctx, f.ID, srcIDs, target.meta.ID, target.allFields, target.policy.mandatory)
			if err != nil {
				return nil, nil, err
			}
			var targetIDs []int64
			seen := map[int64]bool{}
			for _, ids := range raw {
				for _, id := range ids {
					if !seen[id] {
						seen[id] = true
						targetIDs = append(targetIDs, id)
					}
				}
			}
			targetRecords, err := reader.RecordsConstrainedByIDs(ctx, target.meta.ID, targetIDs, target.allFields, target.policy.mandatory)
			if err != nil {
				return nil, nil, err
			}
			target.records = stripBaseRecords(targetRecords, target.allFields, target.policy)
			reads = append(reads, target)
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
		if ok && withExpansions {
			titleField := visibleTitleField(target.fields, target.allFields)
			used := map[int64]bool{}
			for _, tos := range links {
				for _, to := range tos {
					used[to] = true
				}
			}
			ids, names, err := titleMemberNames(ctx, reader, target, titleField, used)
			if err != nil {
				return nil, nil, err
			}
			if len(ids) > 0 {
				check := target
				check.memberIDs, check.memberNames = ids, names
				reads = append(reads, check)
			}
			for _, rec := range target.records {
				if !used[rec.ID] || titleField == nil {
					continue
				}
				if title := visibleRecordTitle(rec, titleField, names); title != "" {
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
	reverse, err := reader.LinkFieldsTargeting(ctx, source.meta.ID)
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
		titleField := visibleTitleField(other.fields, other.allFields)
		for _, f := range other.fields {
			if f.ID == ref.FieldID && f.Type == "link" {
				fieldVisible = true
			}
		}
		if !fieldVisible {
			continue
		}
		if len(srcIDs) == 0 {
			continue
		}
		raw, err := reader.LinksToRecordsConstrained(ctx, ref.FieldID, srcIDs, other.meta.ID, other.allFields, other.policy.mandatory)
		if err != nil {
			return nil, nil, err
		}
		var sourceIDs []int64
		seen := map[int64]bool{}
		for _, ids := range raw {
			for _, id := range ids {
				if !seen[id] {
					seen[id] = true
					sourceIDs = append(sourceIDs, id)
				}
			}
		}
		otherRecords, err := reader.RecordsConstrainedByIDs(ctx, other.meta.ID, sourceIDs, other.allFields, other.policy.mandatory)
		if err != nil {
			return nil, nil, err
		}
		other.records = stripBaseRecords(otherRecords, other.allFields, other.policy)
		reads = append(reads, other)
		allowed := map[int64]bool{}
		for _, record := range other.records {
			allowed[record.ID] = true
		}
		from := map[int64][]int64{}
		used := map[int64]bool{}
		for to, sourceIDs := range raw {
			for _, sourceID := range sourceIDs {
				if self[to] && allowed[sourceID] {
					from[to] = append(from[to], sourceID)
					used[sourceID] = true
				}
			}
		}
		if len(from) == 0 {
			continue
		}
		titles := map[int64]string{}
		ids, names, err := titleMemberNames(ctx, reader, other, titleField, used)
		if err != nil {
			return nil, nil, err
		}
		if len(ids) > 0 {
			check := other
			check.memberIDs, check.memberNames = ids, names
			reads = append(reads, check)
		}
		for _, rec := range other.records {
			if !used[rec.ID] || titleField == nil {
				continue
			}
			if title := visibleRecordTitle(rec, titleField, names); title != "" {
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
