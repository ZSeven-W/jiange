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
	OptionColors []int `json:"optionColors,omitempty"`
	// Description is helper text shown under the field label in forms/details.
	Description string `json:"description,omitempty"`
	// Formula is the expression for type=formula fields (see btformula).
	Formula  string  `json:"formula,omitempty"`
	Position float64 `json:"position"`
	// IsPrimary is the durable identity of the record's main field. It is not
	// inferred from the first visible field, which may change by view or access.
	IsPrimary bool `json:"isPrimary"`
	// DefaultValue (Feishu 默认值) fills this field when a new record omits it.
	DefaultValue json.RawMessage `json:"defaultValue,omitempty"`
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
	"url": true, "phone": true, "email": true, "rating": true, "formula": true,
	"link": true, "lookup": true,
}

// FieldStored reports whether values live in the cells jsonb (link/lookup
// are backed by bt_links instead).
func FieldStored(t string) bool {
	return !FieldReadOnly(t) && t != "link" && t != "lookup"
}

// Computed field types are rendered from record metadata, never written.
func FieldReadOnly(t string) bool {
	return t == "created_by" || t == "created_at" || t == "modified_at"
}

// LinkFieldRef is a link field whose options point at a target base.
type LinkFieldRef struct {
	FieldID int64
	BaseID  int64
}

// BtEvent is one bitable mutation in the per-base realtime event log. Body
// carries the change ({"kind":"cells",...}); Seq orders it globally per base.
type BtEvent struct {
	Seq  int64           `json:"seq"`
	Body json.RawMessage `json:"body"`
	// actor is kept by the in-memory store only; Postgres has bt_events.actor_*.
	actor Actor
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
	// CreateInitializedBase publishes a new base and its default field, view
	// and rows atomically. It rechecks membership and the target parent in the
	// same critical section/transaction as publication.
	CreateInitializedBase(ctx context.Context, workspaceID, creatorID int64, parentID *int64, title string) (DocMeta, error)
	Fields(ctx context.Context, baseID int64) ([]Field, error)
	AddField(ctx context.Context, f Field) (Field, error)
	UpdateField(ctx context.Context, f Field) (Field, error)
	DeleteField(ctx context.Context, baseID, fieldID int64) error
	// MutateFieldGuarded atomically checks the captured schema, permission,
	// locked view dependencies, cell conversion and associated reload events.
	MutateFieldGuarded(ctx context.Context, guard BaseWriteGuard, change FieldMutation) (FieldMutationResult, error)
	// ReorderFieldsGuarded compares the full current field order before
	// changing positions, and commits the reload event with the change.
	ReorderFieldsGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, expected, desired []int64) error
	Records(ctx context.Context, baseID int64) ([]Record, error)
	AddRecord(ctx context.Context, r Record) (Record, error)
	// SetCells merges cells into a record (JSON null deletes a cell).
	SetCells(ctx context.Context, baseID, recordID int64, cells map[string]json.RawMessage) (Record, error)
	// CompareDateCells atomically authorizes, compares and changes one or two
	// date fields. Missing cells and JSON null represent the same empty value.
	CompareDateCells(ctx context.Context, guard BaseWriteGuard, baseID, recordID int64, expected, cells map[string]json.RawMessage) (Record, bool, error)
	// MoveKanbanCard atomically checks the observed placement and changes both
	// the grouping value and position with its event in one transaction.
	MoveKanbanCard(ctx context.Context, guard BaseWriteGuard, baseID, recordID int64, move KanbanMove) (Record, bool, error)
	// MutateRecordGuarded applies the record and any reciprocal link updates
	// together with session/permission checks and durable events. Validate runs
	// under the same lock against a fresh schema and must not perform I/O.
	MutateRecordGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, mutation BaseRecordMutation, validate BaseRecordValidator) (Record, []int64, error)
	// SubmitPublicForm validates and inserts a form response and its event under
	// the same schema/view lock. The validator must not call the Store or do I/O.
	SubmitPublicForm(ctx context.Context, baseID, viewID int64, tokenHash []byte, validate PublicFormValidator) (Record, error)
	// ReadPublicForm returns only a live Base's current form and fields from a
	// single consistent observation; it never revives a deleted form or Base.
	ReadPublicForm(ctx context.Context, baseID, viewID int64, tokenHash []byte) (View, []Field, error)
	// SetPublicFormConfig compares the manager's view/schema snapshot and
	// updates the public form configuration and event atomically.
	SetPublicFormConfig(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64, expectedConfig json.RawMessage, expectedFields []Field, build PublicFormConfigBuilder) (View, error)
	SetPublicFormToken(ctx context.Context, guard BaseWriteGuard, baseID, viewID, expectedRevision int64, tokenHash []byte, snapshot *PublicFormPublishSnapshot) (int64, error)
	PublicFormPublished(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64) (bool, int64, error)
	LookupPublicForm(ctx context.Context, tokenHash []byte) (int64, int64, error)
	// MoveRecord repositions a record (kanban drag within a column).
	MoveRecord(ctx context.Context, baseID, recordID int64, position float64) (Record, error)
	// AddRecordsBulk inserts many records in one batch (CSV import).
	AddRecordsBulk(ctx context.Context, baseID int64, records []Record) error
	// ImportBaseCSV checks authorization and publishes schema, rows and event atomically.
	ImportBaseCSV(ctx context.Context, guard BaseWriteGuard, baseID int64, build BaseImportBuilder) (int, error)
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

	// Record links behind link fields (from_record → to_record).
	SetLinks(ctx context.Context, baseID, fieldID, fromRecord int64, toRecords []int64) error
	LinksForRecords(ctx context.Context, fieldID int64, fromRecords []int64) (map[int64][]int64, error)
	// 双向关联：指向 targetBase 的 link 字段（跨 base 扫描）。
	LinkFieldsTargeting(ctx context.Context, targetBase int64) ([]LinkFieldRef, error)

	Views(ctx context.Context, baseID int64) ([]View, error)
	AddView(ctx context.Context, v View) (View, error)
	UpdateView(ctx context.Context, v View) (View, error)
	DeleteView(ctx context.Context, baseID, viewID int64) error
	AddViewGuarded(ctx context.Context, guard BaseWriteGuard, v View) (View, error)
	UpdateViewGuarded(ctx context.Context, guard BaseWriteGuard, before, after View) (View, error)
	// View mutations use the current session and authorization inside the same
	// critical section as the mutation; reorder requires the exact current set.
	DuplicateView(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64, name string) (View, error)
	RenameViewGuarded(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64, expectedName, name string) (View, error)
	ReorderViews(ctx context.Context, guard BaseWriteGuard, baseID int64, expected, ids []int64) ([]View, error)
	DeleteViewGuarded(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64) error
	// QueryRecords returns the base's records filtered and ordered by a
	// view config, executed server-side (SQL on Postgres, in memory elsewhere).
	QueryRecords(ctx context.Context, baseID int64, fields []Field, cfg btquery.Config, limit int) ([]Record, error)
	// QueryRecordsConstrained applies every mandatory filter with AND, followed
	// by the caller's filter and sort. Constraints cannot be relaxed by an OR
	// in the caller's view configuration.
	QueryRecordsConstrained(ctx context.Context, baseID int64, fields []Field, mandatory []btquery.Config, cfg btquery.Config, limit int) ([]Record, error)
	// RecordConstrained reads a single exact record only if it matches every
	// mandatory access predicate, without truncating at the list's 10k limit.
	RecordConstrained(ctx context.Context, baseID, recordID int64, fields []Field, mandatory []btquery.Config) (Record, error)
	// VisibleRecordIDs returns only IDs in the supplied set that match every
	// mandatory access predicate. It is not limited to the first list page.
	VisibleRecordIDs(ctx context.Context, baseID int64, ids []int64, fields []Field, mandatory []btquery.Config) ([]int64, error)
	RecordsConstrainedByIDs(ctx context.Context, baseID int64, ids []int64, fields []Field, mandatory []btquery.Config) ([]Record, error)
	LinksToRecords(ctx context.Context, fieldID int64, toRecords []int64) (map[int64][]int64, error)
	LinksForRecordsConstrained(ctx context.Context, fieldID int64, fromRecords []int64, targetBaseID int64, fields []Field, mandatory []btquery.Config) (map[int64][]int64, error)
	LinksToRecordsConstrained(ctx context.Context, fieldID int64, toRecords []int64, sourceBaseID int64, fields []Field, mandatory []btquery.Config) (map[int64][]int64, error)
	VisibleMemberNames(ctx context.Context, workspaceID int64, ids []int64) (map[int64]string, error)
}
