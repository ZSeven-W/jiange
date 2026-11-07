package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// BaseRecordMutation describes a single data-row edit. RecordID is ignored for
// add; cells and position are validated again under the transaction lock.
type BaseRecordMutation struct {
	Operation string // add, update, move, delete
	RecordID  int64
	Cells     map[string]json.RawMessage
	Position  float64
}

// BaseRecordValidator validates user-supplied values against the current
// schema while the write lock is held. It must not do I/O or call the Store.
type BaseRecordValidator func([]Field) error

var ErrInvalidBaseRecord = errors.New("store: invalid base record mutation")

type recordLinkChange struct {
	field, target, companion int64
	desired                  []int64
}

func recordLinkChanges(baseID int64, fields []Field, mutation BaseRecordMutation) ([]recordLinkChange, error) {
	if mutation.Operation != "add" && mutation.Operation != "update" && mutation.Operation != "move" && mutation.Operation != "delete" {
		return nil, ErrInvalidBaseRecord
	}
	if mutation.Operation != "add" && mutation.RecordID <= 0 || math.IsNaN(mutation.Position) || math.IsInf(mutation.Position, 0) {
		return nil, ErrInvalidBaseRecord
	}
	if (mutation.Operation == "move" || mutation.Operation == "delete") && len(mutation.Cells) != 0 {
		return nil, ErrInvalidBaseRecord
	}
	var out []recordLinkChange
	for _, f := range fields {
		raw, ok := mutation.Cells[strconv.FormatInt(f.ID, 10)]
		if !ok || f.Type != "link" {
			continue
		}
		if f.BaseID != baseID || len(f.Options) == 0 {
			return nil, ErrInvalidBaseRecord
		}
		target, err := strconv.ParseInt(f.Options[0], 10, 64)
		if err != nil || target <= 0 {
			return nil, ErrInvalidBaseRecord
		}
		var companion int64
		if len(f.Options) > 1 {
			companion, err = strconv.ParseInt(f.Options[1], 10, 64)
			if err != nil || companion <= 0 {
				return nil, ErrInvalidBaseRecord
			}
		}
		var desired []int64
		if len(bytes.TrimSpace(raw)) != 0 && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			if json.Unmarshal(raw, &desired) != nil {
				return nil, ErrInvalidBaseRecord
			}
		}
		seen := map[int64]bool{}
		unique := make([]int64, 0, len(desired))
		for _, id := range desired {
			if id <= 0 {
				return nil, ErrInvalidBaseRecord
			}
			if !seen[id] {
				seen[id] = true
				unique = append(unique, id)
			}
		}
		out = append(out, recordLinkChange{field: f.ID, target: target, companion: companion, desired: unique})
	}
	return out, nil
}

func baseIDsForRecord(baseID int64, changes []recordLinkChange, neighbors []int64) []int64 {
	ids := []int64{baseID}
	for _, c := range changes {
		ids = append(ids, c.target)
	}
	ids = append(ids, neighbors...)
	slices.Sort(ids)
	return slices.Compact(ids)
}

func recordEvent(baseID int64, op string, rec Record, rid int64) ([]byte, error) {
	if op == "delete" {
		return json.Marshal(map[string]any{"kind": "record", "op": "del", "rid": rid})
	}
	verb := "update"
	if op == "add" {
		verb = "add"
	}
	return json.Marshal(map[string]any{"kind": "record", "op": verb, "record": rec})
}

func pgRecordFields(ctx context.Context, tx pgx.Tx, baseID int64) ([]Field, error) {
	rows, err := tx.Query(ctx, `SELECT `+fieldCols+` FROM base_fields WHERE base_id=$1 ORDER BY position,id`, baseID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Field, error) { return scanField(r) })
}

func pgRecordNeighbors(ctx context.Context, tx pgx.Tx, recordID int64) ([]int64, error) {
	rows, err := tx.Query(ctx, `SELECT DISTINCT other.base_id FROM bt_links l
		JOIN base_records other ON other.id=CASE WHEN l.from_record=$1 THEN l.to_record ELSE l.from_record END
		WHERE l.from_record=$1 OR l.to_record=$1 ORDER BY other.base_id`, recordID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (int64, error) { var id int64; err := r.Scan(&id); return id, err })
}

func (p *Postgres) MutateRecordGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, mutation BaseRecordMutation, validate BaseRecordValidator) (result Record, affected []int64, err error) {
	if validate == nil {
		return Record{}, nil, ErrInvalidBaseRecord
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		before, err := pgRecordFields(ctx, tx, baseID)
		if err != nil {
			return err
		}
		changes, err := recordLinkChanges(baseID, before, mutation)
		if err != nil {
			return err
		}
		var neighbors []int64
		if mutation.Operation == "delete" {
			neighbors, err = pgRecordNeighbors(ctx, tx, mutation.RecordID)
			if err != nil {
				return err
			}
		}
		affected = baseIDsForRecord(baseID, changes, neighbors)
		expires, err := lockBaseWrites(ctx, tx, guard, affected)
		if err != nil {
			return err
		}
		// Scalar updates and moves neither alter link edges nor allocate/delete
		// records. Keep the schema stable against legacy writers while allowing
		// unrelated scalar writes to proceed: PostgreSQL's implicit row-exclusive
		// record lock still conflicts with field conversions and imports, which
		// take SHARE ROW EXCLUSIVE on base_records. Structural and link writes
		// retain the stronger transitional fence against legacy writers.
		lockSQL := `LOCK TABLE base_fields,base_records,bt_links IN SHARE ROW EXCLUSIVE MODE`
		if (mutation.Operation == "update" || mutation.Operation == "move") && len(changes) == 0 {
			lockSQL = `LOCK TABLE base_fields IN SHARE MODE`
		}
		if _, err := tx.Exec(ctx, lockSQL); err != nil {
			return err
		}
		fields, err := pgRecordFields(ctx, tx, baseID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(before, fields) {
			return ErrConflict
		}
		if mutation.Operation == "delete" {
			current, err := pgRecordNeighbors(ctx, tx, mutation.RecordID)
			if err != nil {
				return err
			}
			if !slices.Equal(baseIDsForRecord(baseID, changes, current), affected) {
				return ErrConflict
			}
		}
		if err := validate(fields); err != nil {
			return err
		}
		for _, c := range changes {
			if c.companion != 0 {
				var typ string
				var options []byte
				err := tx.QueryRow(ctx, `SELECT type,options FROM base_fields WHERE base_id=$1 AND id=$2`, c.target, c.companion).Scan(&typ, &options)
				if errors.Is(err, pgx.ErrNoRows) {
					return ErrConflict
				}
				if err != nil {
					return err
				}
				var opts []string
				if json.Unmarshal(options, &opts) != nil || typ != "link" || len(opts) < 2 || opts[0] != strconv.FormatInt(baseID, 10) || opts[1] != strconv.FormatInt(c.field, 10) {
					return ErrConflict
				}
			}
			if len(c.desired) > 0 {
				var count int
				if err := tx.QueryRow(ctx, `SELECT count(*) FROM base_records WHERE base_id=$1 AND id=ANY($2)`, c.target, c.desired).Scan(&count); err != nil {
					return err
				}
				if count != len(c.desired) {
					return ErrInvalidBaseRecord
				}
			}
		}
		switch mutation.Operation {
		case "add":
			cells := make(map[string]json.RawMessage, len(mutation.Cells))
			for k, v := range mutation.Cells {
				if !nullCell(v) {
					cells[k] = v
				}
			}
			result, err = scanRecord(tx.QueryRow(ctx, `INSERT INTO base_records (base_id,cells,position,creator_id) VALUES ($1,$2,CASE WHEN $3::float8=0 THEN COALESCE((SELECT max(position) FROM base_records WHERE base_id=$1),0)+1 ELSE $3 END,$4) RETURNING `+recordCols, baseID, cells, mutation.Position, guard.UserID))
		case "update":
			var current Record
			current, err = scanRecord(tx.QueryRow(ctx, `SELECT `+recordCols+` FROM base_records WHERE base_id=$1 AND id=$2 FOR UPDATE`, baseID, mutation.RecordID))
			if err != nil {
				return err
			}
			cells := make(map[string]json.RawMessage, len(current.Cells)+len(mutation.Cells))
			for k, v := range current.Cells {
				cells[k] = slices.Clone(v)
			}
			for k, v := range mutation.Cells {
				if nullCell(v) {
					delete(cells, k)
				} else {
					cells[k] = slices.Clone(v)
				}
			}
			result, err = scanRecord(tx.QueryRow(ctx, `UPDATE base_records SET cells=$3,updated_at=now() WHERE base_id=$1 AND id=$2 RETURNING `+recordCols, baseID, mutation.RecordID, cells))
		case "move":
			result, err = scanRecord(tx.QueryRow(ctx, `UPDATE base_records SET position=$3,updated_at=now() WHERE base_id=$1 AND id=$2 RETURNING `+recordCols, baseID, mutation.RecordID, mutation.Position))
		case "delete":
			result, err = scanRecord(tx.QueryRow(ctx, `DELETE FROM base_records WHERE base_id=$1 AND id=$2 RETURNING `+recordCols, baseID, mutation.RecordID))
		}
		if err != nil {
			return err
		}
		for _, c := range changes {
			if _, err := tx.Exec(ctx, `DELETE FROM bt_links WHERE field_id=$1 AND from_record=$2`, c.field, result.ID); err != nil {
				return err
			}
			if c.companion != 0 {
				if _, err := tx.Exec(ctx, `DELETE FROM bt_links WHERE field_id=$1 AND to_record=$2`, c.companion, result.ID); err != nil {
					return err
				}
			}
			for _, to := range c.desired {
				if _, err := tx.Exec(ctx, `INSERT INTO bt_links(base_id,field_id,from_record,to_record) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, baseID, c.field, result.ID, to); err != nil {
					return err
				}
				if c.companion != 0 {
					if _, err := tx.Exec(ctx, `INSERT INTO bt_links(base_id,field_id,from_record,to_record) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, c.target, c.companion, to, result.ID); err != nil {
						return err
					}
				}
			}
		}
		event, err := recordEvent(baseID, mutation.Operation, result, mutation.RecordID)
		if err != nil {
			return err
		}
		for _, id := range affected {
			body := event
			if id != baseID {
				body = []byte(`{"kind":"reload"}`)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO bt_events(base_id,body) VALUES ($1,$2)`, id, body); err != nil {
				return err
			}
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		if retryableRestoreConflict(err) {
			return Record{}, nil, ErrConflict
		}
		return Record{}, nil, err
	}
	return result, affected, nil
}

func (m *Memory) recordFieldsLocked(baseID int64) []Field {
	fields := []Field{}
	for _, f := range m.b.fields {
		if f.BaseID == baseID {
			f.Options = slices.Clone(f.Options)
			f.OptionColors = slices.Clone(f.OptionColors)
			fields = append(fields, f)
		}
	}
	sort.SliceStable(fields, func(i, j int) bool { return fields[i].Position < fields[j].Position })
	return fields
}

// Other legacy operations append/delete the shared records slice. Validate the
// cached slot before using it so shifting indices cannot select another row.
func (m *Memory) recordIndexLocked(id int64) int {
	if i, ok := m.b.recordIndex[id]; ok && i >= 0 && i < len(m.b.records) && m.b.records[i].ID == id {
		return i
	}
	for i := range m.b.records {
		if m.b.records[i].ID == id {
			if m.b.recordIndex == nil {
				m.b.recordIndex = map[int64]int{}
			}
			m.b.recordIndex[id] = i
			return i
		}
	}
	delete(m.b.recordIndex, id)
	return -1
}

func (m *Memory) recordNeighborsLocked(recordID int64) []int64 {
	bases := map[int64]int64{}
	for _, r := range m.b.records {
		bases[r.ID] = r.BaseID
	}
	seen := map[int64]bool{}
	for key, targets := range m.links {
		if key[1] == recordID {
			for _, id := range targets {
				if b := bases[id]; b > 0 {
					seen[b] = true
				}
			}
		}
		if slices.Contains(targets, recordID) {
			if b := bases[key[1]]; b > 0 {
				seen[b] = true
			}
		}
	}
	ids := make([]int64, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

func (m *Memory) MutateRecordGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, mutation BaseRecordMutation, validate BaseRecordValidator) (Record, []int64, error) {
	if validate == nil {
		return Record{}, nil, ErrInvalidBaseRecord
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Record{}, nil, err
	}
	fields := m.recordFieldsLocked(baseID)
	changes, err := recordLinkChanges(baseID, fields, mutation)
	if err != nil {
		return Record{}, nil, err
	}
	var neighbors []int64
	if mutation.Operation == "delete" {
		neighbors = m.recordNeighborsLocked(mutation.RecordID)
	}
	affected := baseIDsForRecord(baseID, changes, neighbors)
	var expires time.Time
	for _, id := range affected {
		_, exp, err := m.checkBaseWriteLocked(guard, id)
		if err != nil {
			return Record{}, nil, err
		}
		if expires.IsZero() || exp.Before(expires) {
			expires = exp
		}
	}
	if err := validate(fields); err != nil {
		return Record{}, nil, err
	}
	for _, c := range changes {
		if c.companion != 0 {
			found := false
			for _, f := range m.b.fields {
				if f.BaseID == c.target && f.ID == c.companion && f.Type == "link" && len(f.Options) >= 2 && f.Options[0] == strconv.FormatInt(baseID, 10) && f.Options[1] == strconv.FormatInt(c.field, 10) {
					found = true
					break
				}
			}
			if !found {
				return Record{}, nil, ErrConflict
			}
		}
		for _, to := range c.desired {
			i := m.recordIndexLocked(to)
			if i < 0 || m.b.records[i].BaseID != c.target {
				return Record{}, nil, ErrInvalidBaseRecord
			}
		}
	}
	recordIndex := -1
	var result Record
	if mutation.Operation != "add" {
		recordIndex = m.recordIndexLocked(mutation.RecordID)
		if recordIndex < 0 || m.b.records[recordIndex].BaseID != baseID {
			return Record{}, nil, ErrNotFound
		}
		result = m.b.records[recordIndex]
	}
	now := time.Now()
	switch mutation.Operation {
	case "add":
		cells := map[string]json.RawMessage{}
		for k, v := range mutation.Cells {
			if !nullCell(v) {
				cells[k] = slices.Clone(v)
			}
		}
		uid := guard.UserID
		next := m.b.nextID + 1
		result = Record{ID: next, BaseID: baseID, Cells: cells, CreatorID: &uid, CreatedAt: &now, UpdatedAt: &now, Position: mutation.Position}
		if result.Position == 0 {
			result.Position = float64(next)
		}
	case "update":
		cells := map[string]json.RawMessage{}
		for k, v := range result.Cells {
			cells[k] = slices.Clone(v)
		}
		for k, v := range mutation.Cells {
			if nullCell(v) {
				delete(cells, k)
			} else {
				cells[k] = slices.Clone(v)
			}
		}
		result.Cells = cells
		result.UpdatedAt = &now
	case "move":
		result.Position = mutation.Position
		result.UpdatedAt = &now
	}
	// Keep ordinary text/date/number edits independent of the number of links
	// in other Bases. Link mutations use a private copy for atomic rollback.
	var links map[[2]int64][]int64
	if mutation.Operation == "delete" || len(changes) > 0 {
		links = map[[2]int64][]int64{}
		for k, v := range m.links {
			links[k] = slices.Clone(v)
		}
	}
	if mutation.Operation == "delete" {
		for key, targets := range links {
			if key[1] == result.ID {
				delete(links, key)
				continue
			}
			links[key] = slices.DeleteFunc(targets, func(id int64) bool { return id == result.ID })
		}
	} else {
		for _, c := range changes {
			links[[2]int64{c.field, result.ID}] = slices.Clone(c.desired)
			if c.companion != 0 {
				for key, values := range links {
					if key[0] == c.companion {
						links[key] = slices.DeleteFunc(values, func(id int64) bool { return id == result.ID })
					}
				}
				for _, to := range c.desired {
					key := [2]int64{c.companion, to}
					if !slices.Contains(links[key], result.ID) {
						links[key] = append(links[key], result.ID)
					}
				}
			}
		}
	}
	event, err := recordEvent(baseID, mutation.Operation, result, mutation.RecordID)
	if err != nil {
		return Record{}, nil, err
	}
	if err := ctx.Err(); err != nil {
		return Record{}, nil, err
	}
	if !guard.currentTime().Before(expires) {
		return Record{}, nil, ErrUnauthenticated
	}
	switch mutation.Operation {
	case "add":
		m.b.nextID = result.ID
		m.b.records = append(m.b.records, result)
		if m.b.recordIndex != nil {
			m.b.recordIndex[result.ID] = len(m.b.records) - 1
		}
	case "delete":
		m.b.records = slices.Delete(m.b.records, recordIndex, recordIndex+1)
		delete(m.b.recordIndex, result.ID)
	default:
		m.b.records[recordIndex] = result
	}
	if links != nil {
		m.links = links
	}
	for _, id := range affected {
		body := event
		if id != baseID {
			body = []byte(`{"kind":"reload"}`)
		}
		m.appendBtEventLocked(id, body)
	}
	return result, affected, nil
}
