package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type recordHistorian interface {
	RecordEvents(ctx context.Context, base, rid int64, limit int) ([]store.RecordEvent, error)
}

type historyChange struct {
	Field  int64           `json:"f"`
	Before json.RawMessage `json:"before,omitempty"`
	After  json.RawMessage `json:"after,omitempty"`
}

type historyEntry struct {
	Seq     int64           `json:"seq"`
	Op      string          `json:"op"` // add | update
	At      *time.Time      `json:"at,omitempty"`
	By      *int64          `json:"by,omitempty"`
	Changes []historyChange `json:"changes"`
}

// historyFieldTypes are the field types whose raw cells may appear in a
// record's history. Links, lookups and derived values are omitted: their raw
// cells could reveal associations the reader cannot open.
var historyFieldTypes = map[string]bool{"text": true, "number": true, "select": true, "multi_select": true, "checkbox": true, "date": true, "person": true, "url": true, "phone": true, "email": true, "rating": true, "attachment": true}

// recordHistory lists a record's field-level changes, newest first, derived
// from the bt_events snapshots and filtered by the reader's base policy.
func (s *Server) recordHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	b, ok := s.needBase(w, r, store.RoleView)
	if !ok {
		return
	}
	rid := pathID(r, "rid")
	u, _ := UserFrom(r.Context())
	read, err := s.readBaseAllowed(r.Context(), u.ID, b.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	visible := false
	for _, rec := range read.records {
		if rec.ID == rid {
			visible = true
			break
		}
	}
	if !visible {
		httpx.Error(w, http.StatusNotFound, "not_found", "record not found")
		return
	}
	h, ok := s.Store.(recordHistorian)
	if !ok {
		httpx.JSON(w, http.StatusOK, map[string]any{"entries": []historyEntry{}})
		return
	}
	events, err := h.RecordEvents(r.Context(), b.ID, rid, 200)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	allowed := map[string]bool{}
	for _, f := range read.fields {
		if !read.policy.hidden[f.ID] && historyFieldTypes[f.Type] {
			allowed[strconv.FormatInt(f.ID, 10)] = true
		}
	}
	entries := buildRecordHistory(events, allowed)
	httpx.JSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// buildRecordHistory turns newest-first record events into diffs. Only
// fields in allowed are compared; an update that changes nothing visible is dropped.
func buildRecordHistory(events []store.RecordEvent, allowed map[string]bool) []historyEntry {
	type snap struct {
		e   store.RecordEvent
		op  string
		rec *store.Record
	}
	var snaps []snap
	for i := len(events) - 1; i >= 0; i-- { // oldest first
		var body struct {
			Op     string        `json:"op"`
			Record *store.Record `json:"record"`
		}
		if json.Unmarshal(events[i].Body, &body) != nil || body.Record == nil {
			continue
		}
		snaps = append(snaps, snap{events[i], body.Op, body.Record})
	}
	out := []historyEntry{}
	var prev map[string]json.RawMessage
	for _, sn := range snaps {
		var changes []historyChange
		keys := map[string]bool{}
		for k := range sn.rec.Cells {
			keys[k] = true
		}
		for k := range prev {
			keys[k] = true
		}
		ordered := make([]string, 0, len(keys))
		for k := range keys {
			if allowed[k] {
				ordered = append(ordered, k)
			}
		}
		sort.Strings(ordered)
		for _, k := range ordered {
			before, after := prev[k], sn.rec.Cells[k]
			if blankCell(before) && blankCell(after) || bytes.Equal(compactJSON(before), compactJSON(after)) {
				continue
			}
			id, _ := strconv.ParseInt(k, 10, 64)
			changes = append(changes, historyChange{Field: id, Before: nilIfBlank(before), After: nilIfBlank(after)})
		}
		op := "update"
		if sn.op == "add" || prev == nil {
			op = "add"
		}
		prev = sn.rec.Cells
		if op == "update" && len(changes) == 0 {
			continue
		}
		at := sn.rec.UpdatedAt
		if !sn.e.At.IsZero() {
			t := sn.e.At
			at = &t
		}
		entry := historyEntry{Seq: sn.e.Seq, Op: op, At: at, Changes: changes}
		if entry.Changes == nil {
			entry.Changes = []historyChange{}
		}
		if op == "add" {
			entry.By = sn.rec.CreatorID
		}
		out = append(out, entry)
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func blankCell(v json.RawMessage) bool {
	s := string(bytes.TrimSpace(v))
	return s == "" || s == "null" || s == `""` || s == "[]"
}

func nilIfBlank(v json.RawMessage) json.RawMessage {
	if blankCell(v) {
		return nil
	}
	return v
}

func compactJSON(v json.RawMessage) []byte {
	var buf bytes.Buffer
	if json.Compact(&buf, v) != nil {
		return v
	}
	return buf.Bytes()
}
