package engine

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// BaseFieldData mirrors @jiange/base-sdk BaseField.
type BaseFieldData struct {
	ID        int      `json:"id"`
	TableID   int      `json:"tableId"`
	Name      string   `json:"name"`
	Type      string   `json:"type"`
	IsPrimary bool     `json:"isPrimary,omitempty"`
	Options   []string `json:"options,omitempty"`
}

// BaseTableData mirrors @jiange/base-sdk BaseTable.
type BaseTableData struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// BaseRecordData mirrors @jiange/base-sdk BaseRecord.
type BaseRecordData struct {
	ID      int            `json:"id"`
	TableID int            `json:"tableId"`
	Cells   map[string]any `json:"cells"`
}

// BaseData is the pure-Go headless multidimensional Base model.
type BaseData struct {
	Name    string           `json:"name"`
	Tables  []BaseTableData  `json:"tables"`
	Fields  []BaseFieldData  `json:"fields"`
	Records []BaseRecordData `json:"records"`
}

// BasePatchOp represents an atomic Base mutation.
type BasePatchOp struct {
	Op       string         `json:"op"`
	TableID  int            `json:"tableId,omitempty"`
	RecordID int            `json:"recordId,omitempty"`
	Cells    map[string]any `json:"cells,omitempty"`
	Name     string         `json:"name,omitempty"`
	Type     string         `json:"type,omitempty"`
}

// BaseDiag reports schema or record integrity issues.
type BaseDiag struct {
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	TableID    int    `json:"tableId,omitempty"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion"`
}

// LoadBase loads a .json Base snapshot or infers a Base from .csv.
func LoadBase(path string) (*BaseData, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if strings.EqualFold(filepath.Ext(path), ".csv") {
		r := csv.NewReader(bytes.NewReader(raw))
		rows, err := r.ReadAll()
		if err != nil {
			return nil, err
		}
		b := &BaseData{
			Name:   strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)),
			Tables: []BaseTableData{{ID: 1, Name: "Table 1"}},
		}
		if len(rows) == 0 {
			return b, nil
		}
		for i, h := range rows[0] {
			b.Fields = append(b.Fields, BaseFieldData{
				ID: i + 1, TableID: 1, Name: strings.TrimSpace(h), Type: "text", IsPrimary: i == 0,
			})
		}
		for ri, row := range rows[1:] {
			cells := make(map[string]any, len(row))
			for ci, v := range row {
				if n, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && ci > 0 {
					cells[strconv.Itoa(ci+1)] = n
				} else {
					cells[strconv.Itoa(ci+1)] = v
				}
			}
			b.Records = append(b.Records, BaseRecordData{ID: ri + 1, TableID: 1, Cells: cells})
		}
		return b, nil
	}
	var b BaseData
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, err
	}
	return &b, nil
}

// SaveBase writes BaseData as formatted JSON.
func SaveBase(path string, b *BaseData) error {
	raw, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o644)
}

// Inspect returns a compact schema & count summary.
func (b *BaseData) Inspect() map[string]any {
	var tables []map[string]any
	for _, t := range b.Tables {
		var flds []BaseFieldData
		for _, f := range b.Fields {
			if f.TableID == t.ID {
				flds = append(flds, f)
			}
		}
		recCount := 0
		for _, r := range b.Records {
			if r.TableID == t.ID {
				recCount++
			}
		}
		tables = append(tables, map[string]any{
			"id":          t.ID,
			"name":        t.Name,
			"fieldCount":  len(flds),
			"recordCount": recCount,
			"fields":      flds,
		})
	}
	return map[string]any{
		"name":       b.Name,
		"tableCount": len(b.Tables),
		"tables":     tables,
	}
}

// Query filters records by tableId and keyword search.
func (b *BaseData) Query(tableID int, search string, limit int) []BaseRecordData {
	if limit <= 0 {
		limit = 200
	}
	needle := strings.ToLower(strings.TrimSpace(search))
	var out []BaseRecordData
	for _, r := range b.Records {
		if tableID > 0 && r.TableID != tableID {
			continue
		}
		if needle != "" {
			matched := false
			for _, v := range r.Cells {
				if strings.Contains(strings.ToLower(fmt.Sprint(v)), needle) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		out = append(out, r)
		if len(out) >= limit {
			break
		}
	}
	return out
}

// Apply atomically executes BasePatchOps with optional dryRun.
func (b *BaseData) Apply(ops []BasePatchOp, dryRun bool) (int, []string, error) {
	snap, _ := json.Marshal(b)
	restore := func() { _ = json.Unmarshal(snap, b) }

	var diff []string
	nextRecID := 1
	for _, r := range b.Records {
		if r.ID >= nextRecID {
			nextRecID = r.ID + 1
		}
	}
	nextFieldID := 1
	for _, f := range b.Fields {
		if f.ID >= nextFieldID {
			nextFieldID = f.ID + 1
		}
	}

	for i, op := range ops {
		switch op.Op {
		case "addRecord":
			tid := op.TableID
			if tid == 0 && len(b.Tables) > 0 {
				tid = b.Tables[0].ID
			}
			cells := make(map[string]any, len(op.Cells))
			for k, v := range op.Cells {
				cells[k] = v
			}
			id := nextRecID
			nextRecID++
			b.Records = append(b.Records, BaseRecordData{ID: id, TableID: tid, Cells: cells})
			diff = append(diff, fmt.Sprintf("added record #%d in table #%d", id, tid))
		case "addField":
			tid := op.TableID
			if tid == 0 && len(b.Tables) > 0 {
				tid = b.Tables[0].ID
			}
			ft := op.Type
			if ft == "" {
				ft = "text"
			}
			id := nextFieldID
			nextFieldID++
			b.Fields = append(b.Fields, BaseFieldData{ID: id, TableID: tid, Name: op.Name, Type: ft})
			diff = append(diff, fmt.Sprintf("added field %q (#%d)", op.Name, id))
		case "deleteRecord":
			idx := -1
			for ri, r := range b.Records {
				if r.ID == op.RecordID {
					idx = ri
					break
				}
			}
			if idx < 0 {
				restore()
				return 0, nil, fmt.Errorf("op[%d]: record %d not found", i, op.RecordID)
			}
			b.Records = append(b.Records[:idx], b.Records[idx+1:]...)
			diff = append(diff, fmt.Sprintf("deleted record #%d", op.RecordID))
		default:
			restore()
			return 0, nil, fmt.Errorf("op[%d]: unsupported op %q", i, op.Op)
		}
	}
	if dryRun {
		restore()
	}
	return len(diff), diff, nil
}

// Verify checks Base schema consistency.
func (b *BaseData) Verify() []BaseDiag {
	var diags []BaseDiag
	if len(b.Tables) == 0 {
		return []BaseDiag{{
			Code: "EMPTY_BASE", Severity: "error",
			Message: "Base has 0 tables.", Suggestion: "Add at least one table.",
		}}
	}
	for _, t := range b.Tables {
		names := make(map[string]bool)
		for _, f := range b.Fields {
			if f.TableID != t.ID {
				continue
			}
			k := strings.ToLower(strings.TrimSpace(f.Name))
			if names[k] {
				diags = append(diags, BaseDiag{
					Code: "DUPLICATE_FIELD_NAME", Severity: "error", TableID: t.ID,
					Message:    fmt.Sprintf("Duplicate field name %q in table %q.", f.Name, t.Name),
					Suggestion: "Rename duplicate field so references stay unique.",
				})
			}
			names[k] = true
		}
	}
	return diags
}
