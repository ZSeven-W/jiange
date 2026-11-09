package store

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"time"
)

// RecordEvent is one realtime event touching a single record, with the time
// it was appended (zero for the in-memory store, which keeps no clock).
type RecordEvent struct {
	Seq  int64
	At   time.Time
	Body json.RawMessage
}

// RecordEvents returns up to limit events for record rid in base, newest first.
// It reads the existing bt_events log; no new audit table is introduced.
func (p *Postgres) RecordEvents(ctx context.Context, base, rid int64, limit int) ([]RecordEvent, error) {
	rows, err := p.Pool.Query(ctx, `SELECT id, at, body FROM bt_events
		WHERE base_id=$1 AND body->>'kind'='record'
		  AND (body->'record'->>'id' = $2 OR body->>'rid' = $2)
		ORDER BY id DESC LIMIT $3`, base, strconv.FormatInt(rid, 10), limit)
	if err != nil {
		return nil, err
	}
	out := []RecordEvent{}
	for rows.Next() {
		var e RecordEvent
		if err := rows.Scan(&e.Seq, &e.At, &e.Body); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// RecordEvents implements the same query over the in-memory event log.
func (m *Memory) RecordEvents(_ context.Context, base, rid int64, limit int) ([]RecordEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []RecordEvent{}
	events := m.b.events[base]
	for i := len(events) - 1; i >= 0 && len(out) < limit; i-- {
		var probe struct {
			Kind   string `json:"kind"`
			RID    int64  `json:"rid"`
			Record *struct {
				ID int64 `json:"id"`
			} `json:"record"`
		}
		if json.Unmarshal(events[i].Body, &probe) != nil || probe.Kind != "record" {
			continue
		}
		if probe.RID == rid || (probe.Record != nil && probe.Record.ID == rid) {
			out = append(out, RecordEvent{Seq: events[i].Seq, Body: slices.Clone(events[i].Body)})
		}
	}
	return out, nil
}
