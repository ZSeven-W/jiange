package store

import (
	"context"
	"encoding/json"
)

// Field is a typed column of a base.
type Field struct {
	ID       int64    `json:"id"`
	BaseID   int64    `json:"baseId"`
	Name     string   `json:"name"`
	Type     string   `json:"type"`              // text | number | select | checkbox | date
	Options  []string `json:"options,omitempty"` // select choices
	Position float64  `json:"position"`
}

// Record is a row; Cells maps field id (decimal string) to a JSON value.
type Record struct {
	ID       int64                      `json:"id"`
	BaseID   int64                      `json:"baseId"`
	Cells    map[string]json.RawMessage `json:"cells"`
	Position float64                    `json:"position"`
}

var FieldTypes = map[string]bool{"text": true, "number": true, "select": true, "checkbox": true, "date": true}

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
	DeleteRecord(ctx context.Context, baseID, recordID int64) error
}
