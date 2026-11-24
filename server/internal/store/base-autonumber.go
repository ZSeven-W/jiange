package store

import (
	"context"
	"encoding/json"
	"math"
	"strconv"

	"github.com/jackc/pgx/v5"
)

func parseAutonumberCell(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var f float64
	if json.Unmarshal(raw, &f) != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	n := int64(f)
	if n < 0 {
		return 0, false
	}
	return n, true
}

func autonumberKeysForTable(fields []Field, tableID int64) map[string]bool {
	var out map[string]bool
	for _, f := range fields {
		if f.Type == "autonumber" && (tableID == 0 || f.TableID == tableID) {
			if out == nil {
				out = make(map[string]bool)
			}
			out[strconv.FormatInt(f.ID, 10)] = true
		}
	}
	return out
}

func (m *Memory) autonumberSeedsLocked(baseID, tableID int64) map[string]int64 {
	var autoKeys []string
	for _, f := range m.b.fields {
		if f.BaseID == baseID && f.Type == "autonumber" && (tableID == 0 || f.TableID == tableID) {
			autoKeys = append(autoKeys, strconv.FormatInt(f.ID, 10))
		}
	}
	if len(autoKeys) == 0 {
		return nil
	}
	seeds := make(map[string]int64, len(autoKeys))
	for _, k := range autoKeys {
		seeds[k] = 0
	}
	for _, r := range m.b.records {
		if r.BaseID != baseID || (tableID != 0 && r.TableID != tableID) {
			continue
		}
		for _, k := range autoKeys {
			if n, ok := parseAutonumberCell(r.Cells[k]); ok && n > seeds[k] {
				seeds[k] = n
			}
		}
	}
	return seeds
}

// applyAutonumbers assigns the next sequential integer (max+1, starting at 1)
// for each autonumber field in seeds, overwriting any caller-provided value.
func applyAutonumbers(cells map[string]json.RawMessage, seeds map[string]int64) {
	if len(seeds) == 0 {
		return
	}
	for k, maxVal := range seeds {
		next := maxVal + 1
		seeds[k] = next
		cells[k] = json.RawMessage(strconv.FormatInt(next, 10))
	}
}

func pgAutonumberSeeds(ctx context.Context, tx pgx.Tx, baseID, tableID int64) (map[string]int64, error) {
	var rows pgx.Rows
	var err error
	if tableID > 0 {
		rows, err = tx.Query(ctx, `SELECT id FROM base_fields WHERE base_id=$1 AND table_id=$2 AND type='autonumber'`, baseID, tableID)
	} else {
		rows, err = tx.Query(ctx, `SELECT id FROM base_fields WHERE base_id=$1 AND type='autonumber'`, baseID)
	}
	if err != nil {
		return nil, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(ids) == 0 {
		return nil, nil
	}
	seeds := make(map[string]int64, len(ids))
	for _, id := range ids {
		key := strconv.FormatInt(id, 10)
		var maxVal int64
		if tableID > 0 {
			err = tx.QueryRow(ctx, `SELECT COALESCE(MAX(FLOOR((cells ->> $3)::float8)::bigint), 0) FROM base_records WHERE base_id=$1 AND table_id=$2 AND jsonb_typeof(cells -> $3) = 'number'`, baseID, tableID, key).Scan(&maxVal)
		} else {
			err = tx.QueryRow(ctx, `SELECT COALESCE(MAX(FLOOR((cells ->> $2)::float8)::bigint), 0) FROM base_records WHERE base_id=$1 AND jsonb_typeof(cells -> $2) = 'number'`, baseID, key).Scan(&maxVal)
		}
		if err != nil {
			return nil, err
		}
		if maxVal < 0 {
			maxVal = 0
		}
		seeds[key] = maxVal
	}
	return seeds, nil
}
