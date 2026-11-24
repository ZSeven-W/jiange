package store

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	sheetMaxDefinedNames       = 200
	sheetMaxDefinedNameRef     = 512
	sheetMaxDefinedNameComment = 256
)

// ErrInvalidSheetDefinedName reports malformed, oversized, or duplicate defined names.
var ErrInvalidSheetDefinedName = errors.New("store: invalid sheet defined name")

var sheetDefinedNameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.]{0,63}$`)

// SheetDefinedName describes a workbook-global or worksheet-scoped named range / constant.
type SheetDefinedName struct {
	Name    string `json:"name"`
	Ref     string `json:"ref"`
	SheetID *int64 `json:"sheetId,omitempty"`
	Comment string `json:"comment,omitempty"`
}

// SheetDefinedNamesStore manages cloud-persisted spreadsheet defined names.
type SheetDefinedNamesStore interface {
	GetSheetDefinedNames(ctx context.Context, guard RestoreGuard, sheetID int64) ([]SheetDefinedName, error)
	SaveSheetDefinedNamesGuarded(ctx context.Context, guard RestoreGuard, sheetID int64, names []SheetDefinedName) ([]SheetDefinedName, error)
}

var (
	_ SheetDefinedNamesStore = (*Memory)(nil)
	_ SheetDefinedNamesStore = (*Postgres)(nil)
)

// memSheetDefinedNames holds in-memory workbook defined names for Memory store.
type memSheetDefinedNames struct {
	bySheet map[int64][]SheetDefinedName
}

type sheetDefinedNameScopeKey struct {
	lowerName string
	hasSheet  bool
	sheetID   int64
}

func cloneSheetDefinedNames(in []SheetDefinedName) []SheetDefinedName {
	if len(in) == 0 {
		return []SheetDefinedName{}
	}
	out := make([]SheetDefinedName, len(in))
	for i, item := range in {
		cp := SheetDefinedName{
			Name:    item.Name,
			Ref:     item.Ref,
			Comment: item.Comment,
		}
		if item.SheetID != nil {
			sid := *item.SheetID
			cp.SheetID = &sid
		}
		out[i] = cp
	}
	return out
}

func sanitizeSheetDefinedNames(names []SheetDefinedName) ([]SheetDefinedName, error) {
	if len(names) > sheetMaxDefinedNames {
		return nil, ErrInvalidSheetDefinedName
	}
	if len(names) == 0 {
		return []SheetDefinedName{}, nil
	}
	seen := make(map[sheetDefinedNameScopeKey]struct{}, len(names))
	out := make([]SheetDefinedName, 0, len(names))
	for _, item := range names {
		name := strings.TrimSpace(item.Name)
		if !sheetDefinedNameRe.MatchString(name) {
			return nil, ErrInvalidSheetDefinedName
		}
		ref := strings.TrimSpace(item.Ref)
		if ref == "" || !utf8.ValidString(ref) || strings.ContainsRune(ref, '\x00') || utf8.RuneCountInString(ref) > sheetMaxDefinedNameRef {
			return nil, ErrInvalidSheetDefinedName
		}
		comment := strings.TrimSpace(item.Comment)
		if !utf8.ValidString(comment) || strings.ContainsRune(comment, '\x00') || utf8.RuneCountInString(comment) > sheetMaxDefinedNameComment {
			return nil, ErrInvalidSheetDefinedName
		}
		var sheetIDPtr *int64
		key := sheetDefinedNameScopeKey{lowerName: strings.ToLower(name)}
		if item.SheetID != nil {
			if !validSheetID(*item.SheetID) {
				return nil, ErrInvalidSheetDefinedName
			}
			sid := *item.SheetID
			sheetIDPtr = &sid
			key.hasSheet = true
			key.sheetID = sid
		}
		if _, dup := seen[key]; dup {
			return nil, ErrInvalidSheetDefinedName
		}
		seen[key] = struct{}{}
		out = append(out, SheetDefinedName{
			Name:    name,
			Ref:     ref,
			SheetID: sheetIDPtr,
			Comment: comment,
		})
	}
	return out, nil
}

// --- Memory implementation ---

func (m *Memory) GetSheetDefinedNames(ctx context.Context, guard RestoreGuard, sheetID int64) ([]SheetDefinedName, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, _, _, expires, err := m.authorizeSheetLocked(ctx, guard, sheetID, RoleView); err != nil {
		return nil, err
	} else if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	return cloneSheetDefinedNames(m.sheetDefinedNames.bySheet[sheetID]), nil
}

func (m *Memory) SaveSheetDefinedNamesGuarded(ctx context.Context, guard RestoreGuard, sheetID int64, names []SheetDefinedName) ([]SheetDefinedName, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, _, _, expires, err := m.authorizeSheetLocked(ctx, guard, sheetID, RoleEdit)
	if err != nil {
		return nil, err
	}
	clean, err := sanitizeSheetDefinedNames(names)
	if err != nil {
		return nil, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	if m.sheetDefinedNames.bySheet == nil {
		m.sheetDefinedNames.bySheet = map[int64][]SheetDefinedName{}
	}
	m.sheetDefinedNames.bySheet[sheetID] = cloneSheetDefinedNames(clean)
	d.meta.UpdatedAt = guard.currentTime().UTC()
	m.setDocumentModifierLocked(d, guard.UserID)
	return cloneSheetDefinedNames(clean), nil
}

// --- PostgreSQL implementation ---

func (p *Postgres) GetSheetDefinedNames(ctx context.Context, guard RestoreGuard, sheetID int64) (out []SheetDefinedName, err error) {
	out = []SheetDefinedName{}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockSheetPG(ctx, tx, guard, sheetID, RoleView, false)
		if e != nil {
			return e
		}
		var raw []byte
		e = tx.QueryRow(ctx, `SELECT defined_names FROM sheet_defined_names WHERE sheet_id = $1`, sheetID).Scan(&raw)
		if errors.Is(e, pgx.ErrNoRows) {
			out = []SheetDefinedName{}
			return drivePGEnd(ctx, guard, expires)
		}
		if e != nil {
			return e
		}
		var parsed []SheetDefinedName
		if len(raw) > 0 {
			if e = json.Unmarshal(raw, &parsed); e != nil {
				return e
			}
		}
		out = cloneSheetDefinedNames(parsed)
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) SaveSheetDefinedNamesGuarded(ctx context.Context, guard RestoreGuard, sheetID int64, names []SheetDefinedName) (out []SheetDefinedName, err error) {
	out = []SheetDefinedName{}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockSheetPG(ctx, tx, guard, sheetID, RoleEdit, true)
		if e != nil {
			return e
		}
		clean, e := sanitizeSheetDefinedNames(names)
		if e != nil {
			return e
		}
		rawJSON, e := json.Marshal(clean)
		if e != nil {
			return e
		}
		if e = drivePGEnd(ctx, guard, expires); e != nil {
			return e
		}
		var updatedBy *int64
		if guard.UserID > 0 {
			uid := guard.UserID
			updatedBy = &uid
		}
		_, e = tx.Exec(ctx, `
			INSERT INTO sheet_defined_names (sheet_id, defined_names, updated_by, updated_at)
			VALUES ($1, $2::jsonb, $3, now())
			ON CONFLICT (sheet_id) DO UPDATE
			SET defined_names = EXCLUDED.defined_names,
			    updated_by = EXCLUDED.updated_by,
			    updated_at = now()`,
			sheetID, string(rawJSON), updatedBy,
		)
		if e != nil {
			return e
		}
		out = cloneSheetDefinedNames(clean)
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}
