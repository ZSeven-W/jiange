package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
)

// Field is a typed column of a base.
type Field struct {
	ID      int64    `json:"id"`
	BaseID  int64    `json:"baseId"`
	Name    string   `json:"name"`
	Type    string   `json:"type"`              // see FieldTypes
	Options []string `json:"options,omitempty"` // select / multi_select choices
	// OptionColors parallels Options: preset palette index per option (-1 = auto).
	OptionColors []int   `json:"optionColors,omitempty"`
	Position     float64 `json:"position"`
}

// Record is a row; Cells maps field id (decimal string) to a JSON value.
// CreatorID/CreatedAt/UpdatedAt back the computed created_by/created_at/
// modified_at field types and are never stored in Cells.
type Record struct {
	ID        int64                      `json:"id"`
	BaseID    int64                      `json:"baseId"`
	Cells     map[string]json.RawMessage `json:"cells"`
	Position  float64                    `json:"position"`
	CreatorID *int64                     `json:"creatorId,omitempty"`
	CreatedAt *time.Time                 `json:"createdAt,omitempty"`
	UpdatedAt *time.Time                 `json:"updatedAt,omitempty"`
}

// The field type registry: every type the server accepts.
var FieldTypes = map[string]bool{
	"text": true, "number": true, "select": true, "checkbox": true, "date": true,
	"multi_select": true, "person": true, "attachment": true,
	"created_by": true, "created_at": true, "modified_at": true,
}

// Computed field types are rendered from record metadata, never written.
func FieldReadOnly(t string) bool {
	return t == "created_by" || t == "created_at" || t == "modified_at"
}

// BtEvent is one bitable mutation in the per-base realtime event log. Body
// carries the change ({"kind":"cells",...}); Seq orders it globally per base.
type BtEvent struct {
	Seq  int64           `json:"seq"`
	Body json.RawMessage `json:"body"`
}

// View is a saved grid/kanban configuration (filters, sorts, group, hidden).
type View struct {
	ID     int64           `json:"id"`
	BaseID int64           `json:"baseId"`
	Type   string          `json:"type"` // grid | kanban
	Name   string          `json:"name"`
	Config json.RawMessage `json:"config"`
	Pos    float64         `json:"pos"`
}

// BaseStore persists bitable schemas and rows. Access control is done by
// the caller through GetDoc on the base node (kind 'base').
type BaseStore interface {
	CreateBase(ctx context.Context, workspaceID, creatorID int64, parentID *int64, title string) (DocMeta, error)
	Fields(ctx context.Context, baseID int64) ([]Field, error)
	AddField(ctx context.Context, f Field) (Field, error)
	UpdateField(ctx context.Context, f Field) (Field, error)
	DeleteField(ctx context.Context, baseID, fieldID int64) error
	Records(ctx context.Context, baseID int64) ([]Record, error)
	AddRecord(ctx context.Context, r Record) (Record, error)
	// SetCells merges cells into a record (JSON null deletes a cell).
	SetCells(ctx context.Context, baseID, recordID int64, cells map[string]json.RawMessage) (Record, error)
	// MoveRecord repositions a record (kanban drag within a column).
	MoveRecord(ctx context.Context, baseID, recordID int64, position float64) (Record, error)
	// AddRecordsBulk inserts many records in one batch (CSV import).
	AddRecordsBulk(ctx context.Context, baseID int64, records []Record) error
	DeleteRecord(ctx context.Context, baseID, recordID int64) error
	// MapFieldCells rewrites every stored cell of fieldID through fn; fn
	// returning nil deletes the cell. Used when a field changes type.
	MapFieldCells(ctx context.Context, baseID, fieldID int64, fn func(json.RawMessage) json.RawMessage) error

	// AppendBtEvent appends a realtime event and returns its seq.
	AppendBtEvent(ctx context.Context, baseID int64, body json.RawMessage) (int64, error)
	// BtEventsAfter returns up to limit events with seq > after, in order.
	BtEventsAfter(ctx context.Context, baseID, after int64, limit int) ([]BtEvent, error)
	// BtHead is the newest event seq for the base (0 when none).
	BtHead(ctx context.Context, baseID int64) (int64, error)

	Views(ctx context.Context, baseID int64) ([]View, error)
	AddView(ctx context.Context, v View) (View, error)
	UpdateView(ctx context.Context, v View) (View, error)
	DeleteView(ctx context.Context, baseID, viewID int64) error
	// QueryRecords returns the base's records filtered and ordered by a
	// view config, executed server-side (SQL on Postgres, in memory elsewhere).
	QueryRecords(ctx context.Context, baseID int64, fields []Field, cfg btquery.Config, limit int) ([]Record, error)
}
