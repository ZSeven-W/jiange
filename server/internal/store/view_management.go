package store

import (
	"bytes"
	"context"
	"encoding/json"
	"sort"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/jackc/pgx/v5"
)

// View operations below serialize against all other mutations of the view
// list. They append the reload event atomically with the list change.
func viewCopyName(original, requested string) (string, error) {
	if requested != "" {
		if !utf8.ValidString(requested) || utf8.RuneCountInString(requested) > 100 {
			return "", ErrConflict
		}
		return requested, nil
	}
	runes := []rune(original)
	if len(runes) > 97 {
		runes = runes[:97]
	}
	return string(runes) + " 副本", nil
}

func guardedViewValid(role string, v View, fields []Field) error {
	if v.Name == "" || !utf8.ValidString(v.Name) || utf8.RuneCountInString(v.Name) > 100 {
		return ErrConflict
	}
	if v.Type != "grid" && v.Type != "kanban" && v.Type != "gallery" && v.Type != "calendar" && v.Type != "form" && v.Type != "gantt" {
		return ErrConflict
	}
	var cfg btquery.Config
	if len(v.Config) > 0 && string(v.Config) != "null" && json.Unmarshal(v.Config, &cfg) != nil {
		return ErrConflict
	}
	if cfg.Locked && role != RoleManage {
		return ErrForbidden
	}
	if err := btquery.Validate(Specs(fields), cfg); err != nil {
		return ErrConflict
	}
	if cfg.Locked {
		if err := btquery.ValidateLocked(Specs(fields), cfg); err != nil {
			return ErrConflict
		}
	}
	return nil
}

// Preserve already-hidden legacy configurations (especially locked permission
// views) without exposing their data, but do not permit new hidden-primary
// configurations. Existing users can explicitly unhide the primary field.
func primaryVisibilityValid(before *View, after View, fields []Field) error {
	var primaryID int64
	for _, field := range fields {
		if field.IsPrimary {
			primaryID = field.ID
			break
		}
	}
	if primaryID == 0 {
		return nil
	}
	hidden := func(view View) bool {
		var cfg btquery.Config
		if len(view.Config) == 0 || string(view.Config) == "null" || json.Unmarshal(view.Config, &cfg) != nil {
			return false
		}
		for _, id := range cfg.Hidden {
			if id == primaryID {
				return true
			}
		}
		return false
	}
	if hidden(after) && (before == nil || !hidden(*before)) {
		return ErrPrimaryField
	}
	return nil
}

func (m *Memory) viewFieldsLocked(baseID int64) []Field {
	var fields []Field
	for _, f := range m.b.fields {
		if f.BaseID == baseID {
			fields = append(fields, f)
		}
	}
	return fields
}

func sameView(a, b View) bool {
	return a.ID == b.ID && a.BaseID == b.BaseID && a.Type == b.Type && a.Name == b.Name && a.Pos == b.Pos && bytes.Equal(a.Config, b.Config)
}

func (m *Memory) viewOrderLocked(baseID int64) []View {
	out := make([]View, 0)
	for _, v := range m.b.views {
		if v.BaseID == baseID {
			v.Config = append(json.RawMessage(nil), v.Config...)
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Pos == out[j].Pos {
			return out[i].ID < out[j].ID
		}
		return out[i].Pos < out[j].Pos
	})
	return out
}

func exactViewOrder(views []View, ids []int64) ([]View, error) {
	if len(views) == 0 || len(ids) != len(views) || len(ids) > 1000 {
		return nil, ErrConflict
	}
	byID := make(map[int64]View, len(views))
	for _, v := range views {
		byID[v.ID] = v
	}
	ordered := make([]View, 0, len(ids))
	for _, id := range ids {
		v, ok := byID[id]
		if !ok {
			return nil, ErrConflict
		}
		delete(byID, id)
		ordered = append(ordered, v)
	}
	return ordered, nil
}

func viewOrderMatches(views []View, ids []int64) bool {
	if len(views) != len(ids) {
		return false
	}
	for i := range views {
		if views[i].ID != ids[i] {
			return false
		}
	}
	return true
}

func (m *Memory) saveViewOrderLocked(baseID int64, ordered []View) {
	positions := make(map[int64]float64, len(ordered))
	for i := range ordered {
		ordered[i].Pos = float64(i + 1)
		positions[ordered[i].ID] = ordered[i].Pos
	}
	for i := range m.b.views {
		if m.b.views[i].BaseID == baseID {
			m.b.views[i].Pos = positions[m.b.views[i].ID]
		}
	}
}

func (m *Memory) recordViewReloadLocked(baseID int64) {
	m.appendBtEventLocked(baseID, json.RawMessage(`{"kind":"reload"}`))
}

func (m *Memory) AddViewGuarded(ctx context.Context, guard BaseWriteGuard, v View) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	role, expiry, err := m.checkBaseWriteLocked(guard, v.BaseID)
	if err != nil {
		return View{}, err
	}
	if v.Type == "" {
		v.Type = "grid"
	}
	if v.Config == nil {
		v.Config = json.RawMessage(`{}`)
	}
	if err = guardedViewValid(role, v, m.viewFieldsLocked(v.BaseID)); err != nil {
		return View{}, err
	}
	if err = primaryVisibilityValid(nil, v, m.viewFieldsLocked(v.BaseID)); err != nil {
		return View{}, err
	}
	if err = ctx.Err(); err != nil {
		return View{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return View{}, ErrUnauthenticated
	}
	v.ID = m.id()
	if v.Pos == 0 {
		current := m.viewOrderLocked(v.BaseID)
		if len(current) == 0 {
			v.Pos = 1
		} else {
			v.Pos = current[len(current)-1].Pos + 1
		}
	}
	v.Config = append(json.RawMessage(nil), v.Config...)
	m.b.views = append(m.b.views, v)
	m.recordViewReloadLocked(v.BaseID)
	v.Config = append(json.RawMessage(nil), v.Config...)
	return v, nil
}

func (m *Memory) UpdateViewGuarded(ctx context.Context, guard BaseWriteGuard, before, after View) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	role, expiry, err := m.checkBaseWriteLocked(guard, before.BaseID)
	if err != nil {
		return View{}, err
	}
	if after.ID != before.ID || after.BaseID != before.BaseID {
		return View{}, ErrConflict
	}
	if err = guardedViewValid(role, after, m.viewFieldsLocked(before.BaseID)); err != nil {
		return View{}, err
	}
	if err = primaryVisibilityValid(&before, after, m.viewFieldsLocked(before.BaseID)); err != nil {
		return View{}, err
	}
	for i, v := range m.b.views {
		if v.ID != before.ID || v.BaseID != before.BaseID {
			continue
		}
		if !sameView(v, before) {
			return View{}, ErrConflict
		}
		if role != RoleManage && v.Type == "form" && validPublicFormHash(m.b.formLinks[[2]int64{before.BaseID, before.ID}].hash) && (after.Type != "form" || !samePublicFormConfig(v.Config, after.Config)) {
			return View{}, ErrForbidden
		}
		if err = ctx.Err(); err != nil {
			return View{}, err
		}
		if !guard.currentTime().Before(expiry) {
			return View{}, ErrUnauthenticated
		}
		if err = m.invalidateFormOnTypeChangeLocked(v, after); err != nil {
			return View{}, err
		}
		after.Config = append(json.RawMessage(nil), after.Config...)
		m.b.views[i] = after
		m.recordViewReloadLocked(before.BaseID)
		after.Config = append(json.RawMessage(nil), after.Config...)
		return after, nil
	}
	return View{}, ErrNotFound
}

func (m *Memory) RenameViewGuarded(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64, expectedName, name string) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expiry, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return View{}, err
	}
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > 100 {
		return View{}, ErrConflict
	}
	for i, v := range m.b.views {
		if v.BaseID != baseID || v.ID != viewID {
			continue
		}
		if v.Name != expectedName {
			return View{}, ErrConflict
		}
		if err = ctx.Err(); err != nil {
			return View{}, err
		}
		if !guard.currentTime().Before(expiry) {
			return View{}, ErrUnauthenticated
		}
		if v.Name != name {
			m.b.views[i].Name = name
			m.recordViewReloadLocked(baseID)
		}
		v.Name = name
		v.Config = append(json.RawMessage(nil), v.Config...)
		return v, nil
	}
	return View{}, ErrNotFound
}

func (m *Memory) DuplicateView(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64, name string) (View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	role, expiry, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return View{}, err
	}
	ordered := m.viewOrderLocked(baseID)
	index := -1
	for i, v := range ordered {
		if v.ID == viewID {
			index = i
			break
		}
	}
	if index < 0 {
		return View{}, ErrNotFound
	}
	if err = guardedViewValid(role, ordered[index], m.viewFieldsLocked(baseID)); err != nil {
		return View{}, err
	}
	name, err = viewCopyName(ordered[index].Name, name)
	if err != nil {
		return View{}, err
	}
	if err = ctx.Err(); err != nil {
		return View{}, err
	}
	if !guard.currentTime().Before(expiry) {
		return View{}, ErrUnauthenticated
	}
	copyView := ordered[index]
	copyView.ID, copyView.Name = m.id(), name
	copyView.Config = append(json.RawMessage(nil), copyView.Config...)
	ordered = append(ordered, View{})
	copy(ordered[index+2:], ordered[index+1:])
	ordered[index+1] = copyView
	m.b.views = append(m.b.views, copyView)
	m.saveViewOrderLocked(baseID, ordered)
	copyView.Pos = float64(index + 2)
	m.recordViewReloadLocked(baseID)
	return copyView, nil
}

func (m *Memory) ReorderViews(ctx context.Context, guard BaseWriteGuard, baseID int64, expected, ids []int64) ([]View, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expiry, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return nil, err
	}
	current := m.viewOrderLocked(baseID)
	if !viewOrderMatches(current, expected) {
		return nil, ErrConflict
	}
	ordered, err := exactViewOrder(current, ids)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if !guard.currentTime().Before(expiry) {
		return nil, ErrUnauthenticated
	}
	m.saveViewOrderLocked(baseID, ordered)
	m.recordViewReloadLocked(baseID)
	return ordered, nil
}

func (m *Memory) DeleteViewGuarded(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	role, expiry, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return err
	}
	ordered := m.viewOrderLocked(baseID)
	found := false
	for _, v := range ordered {
		if v.ID == viewID {
			if role != RoleManage && v.Type == "form" && validPublicFormHash(m.b.formLinks[[2]int64{baseID, viewID}].hash) {
				return ErrForbidden
			}
			found = true
			break
		}
	}
	if !found {
		return ErrNotFound
	}
	if len(ordered) <= 1 {
		return ErrConflict
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if !guard.currentTime().Before(expiry) {
		return ErrUnauthenticated
	}
	out := m.b.views[:0]
	for _, v := range m.b.views {
		if v.BaseID != baseID || v.ID != viewID {
			out = append(out, v)
		}
	}
	m.b.views = out
	delete(m.b.formLinks, [2]int64{baseID, viewID})
	m.recordViewReloadLocked(baseID)
	return nil
}

func pgViewsLocked(ctx context.Context, tx pgx.Tx, baseID int64) ([]View, error) {
	rows, err := tx.Query(ctx, `SELECT id,base_id,type,name,config,pos FROM bt_views WHERE base_id=$1 ORDER BY pos,id`, baseID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (v View, err error) {
		err = r.Scan(&v.ID, &v.BaseID, &v.Type, &v.Name, &v.Config, &v.Pos)
		return v, err
	})
}

// Existing field mutations do not all acquire the Base node lock. A shared
// table lock prevents concurrent schema writes while a view config is checked
// and published; it can be narrowed once all field mutations use that lock.
func pgViewFieldsLocked(ctx context.Context, tx pgx.Tx, baseID int64) ([]Field, error) {
	if _, err := tx.Exec(ctx, `LOCK TABLE base_fields IN SHARE MODE`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT `+fieldCols+` FROM base_fields WHERE base_id=$1 ORDER BY position,id`, baseID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Field, error) { return scanField(r) })
}
func pgWriteViewOrder(ctx context.Context, tx pgx.Tx, baseID int64, ordered []View) error {
	for i := range ordered {
		ordered[i].Pos = float64(i + 1)
		tag, err := tx.Exec(ctx, `UPDATE bt_views SET pos=$3 WHERE base_id=$1 AND id=$2`, baseID, ordered[i].ID, ordered[i].Pos)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrConflict
		}
	}
	return nil
}
func pgViewReload(ctx context.Context, tx pgx.Tx, baseID int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO bt_events (base_id,body) VALUES ($1,'{"kind":"reload"}'::jsonb)`, baseID)
	return err
}

func (p *Postgres) AddViewGuarded(ctx context.Context, guard BaseWriteGuard, v View) (result View, err error) {
	if v.Type == "" {
		v.Type = "grid"
	}
	if v.Config == nil {
		v.Config = json.RawMessage(`{}`)
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		role, expiry, err := lockBaseWrite(ctx, tx, guard, v.BaseID)
		if err != nil {
			return err
		}
		fields, err := pgViewFieldsLocked(ctx, tx, v.BaseID)
		if err != nil {
			return err
		}
		if err = guardedViewValid(role, v, fields); err != nil {
			return err
		}
		if err = primaryVisibilityValid(nil, v, fields); err != nil {
			return err
		}
		result = v
		err = tx.QueryRow(ctx, `INSERT INTO bt_views (base_id,type,name,config,pos)
			VALUES ($1,$2,$3,$4,CASE WHEN $5::float8=0 THEN COALESCE((SELECT max(pos) FROM bt_views WHERE base_id=$1),0)+1 ELSE $5 END)
			RETURNING id,config,pos`, v.BaseID, v.Type, v.Name, v.Config, v.Pos).Scan(&result.ID, &result.Config, &result.Pos)
		if err != nil {
			return err
		}
		if err = pgViewReload(ctx, tx, v.BaseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		return View{}, ErrConflict
	}
	return result, err
}

func (p *Postgres) UpdateViewGuarded(ctx context.Context, guard BaseWriteGuard, before, after View) (result View, err error) {
	if after.ID != before.ID || after.BaseID != before.BaseID {
		return View{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		role, expiry, err := lockBaseWrite(ctx, tx, guard, before.BaseID)
		if err != nil {
			return err
		}
		fields, err := pgViewFieldsLocked(ctx, tx, before.BaseID)
		if err != nil {
			return err
		}
		if err = guardedViewValid(role, after, fields); err != nil {
			return err
		}
		if err = primaryVisibilityValid(&before, after, fields); err != nil {
			return err
		}
		views, err := pgViewsLocked(ctx, tx, before.BaseID)
		if err != nil {
			return err
		}
		found := false
		for _, v := range views {
			if v.ID == before.ID {
				if !sameView(v, before) {
					return ErrConflict
				}
				if role != RoleManage && v.Type == "form" && (after.Type != "form" || !samePublicFormConfig(v.Config, after.Config)) {
					var published bool
					if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bt_public_form_links WHERE base_id=$1 AND view_id=$2 AND token_hash IS NOT NULL)`, before.BaseID, before.ID).Scan(&published); err != nil {
						return err
					}
					if published {
						return ErrForbidden
					}
				}
				found = true
				break
			}
		}
		if !found {
			return ErrNotFound
		}
		result = after
		err = tx.QueryRow(ctx, `UPDATE bt_views SET type=$3,name=$4,config=$5,pos=$6 WHERE base_id=$1 AND id=$2 RETURNING config,pos`,
			before.BaseID, before.ID, after.Type, after.Name, after.Config, after.Pos).Scan(&result.Config, &result.Pos)
		if err != nil {
			return notFound(err)
		}
		if err = pgViewReload(ctx, tx, before.BaseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		return View{}, ErrConflict
	}
	return result, err
}

func (p *Postgres) RenameViewGuarded(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64, expectedName, name string) (result View, err error) {
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > 100 {
		return View{}, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expiry, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		views, err := pgViewsLocked(ctx, tx, baseID)
		if err != nil {
			return err
		}
		found := false
		for _, v := range views {
			if v.ID == viewID {
				result = v
				found = true
				break
			}
		}
		if !found {
			return ErrNotFound
		}
		if result.Name != expectedName {
			return ErrConflict
		}
		if result.Name != name {
			if _, err = tx.Exec(ctx, `UPDATE bt_views SET name=$3 WHERE base_id=$1 AND id=$2`, baseID, viewID, name); err != nil {
				return err
			}
			if err = pgViewReload(ctx, tx, baseID); err != nil {
				return err
			}
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		result.Name = name
		return nil
	})
	if retryableRestoreConflict(err) {
		return View{}, ErrConflict
	}
	return result, err
}

func (p *Postgres) DuplicateView(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64, name string) (result View, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		role, expiry, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		ordered, err := pgViewsLocked(ctx, tx, baseID)
		if err != nil {
			return err
		}
		index := -1
		for i, v := range ordered {
			if v.ID == viewID {
				index = i
				break
			}
		}
		if index < 0 {
			return ErrNotFound
		}
		fields, err := pgViewFieldsLocked(ctx, tx, baseID)
		if err != nil {
			return err
		}
		if err = guardedViewValid(role, ordered[index], fields); err != nil {
			return err
		}
		name, err = viewCopyName(ordered[index].Name, name)
		if err != nil {
			return err
		}
		result = ordered[index]
		result.Name = name
		err = tx.QueryRow(ctx, `INSERT INTO bt_views (base_id,type,name,config,pos) VALUES ($1,$2,$3,$4,0) RETURNING id`, baseID, result.Type, result.Name, result.Config).Scan(&result.ID)
		if err != nil {
			return err
		}
		ordered = append(ordered, View{})
		copy(ordered[index+2:], ordered[index+1:])
		ordered[index+1] = result
		if err = pgWriteViewOrder(ctx, tx, baseID, ordered); err != nil {
			return err
		}
		if err = pgViewReload(ctx, tx, baseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		result.Pos = float64(index + 2)
		return nil
	})
	if retryableRestoreConflict(err) {
		return View{}, ErrConflict
	}
	return result, err
}

func (p *Postgres) ReorderViews(ctx context.Context, guard BaseWriteGuard, baseID int64, expected, ids []int64) (result []View, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expiry, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		views, err := pgViewsLocked(ctx, tx, baseID)
		if err != nil {
			return err
		}
		if !viewOrderMatches(views, expected) {
			return ErrConflict
		}
		result, err = exactViewOrder(views, ids)
		if err != nil {
			return err
		}
		if err = pgWriteViewOrder(ctx, tx, baseID, result); err != nil {
			return err
		}
		if err = pgViewReload(ctx, tx, baseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		return nil, ErrConflict
	}
	return result, err
}

func (p *Postgres) DeleteViewGuarded(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		role, expiry, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		views, err := pgViewsLocked(ctx, tx, baseID)
		if err != nil {
			return err
		}
		found := false
		for _, v := range views {
			if v.ID == viewID {
				if role != RoleManage && v.Type == "form" {
					var published bool
					if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bt_public_form_links WHERE base_id=$1 AND view_id=$2 AND token_hash IS NOT NULL)`, baseID, viewID).Scan(&published); err != nil {
						return err
					}
					if published {
						return ErrForbidden
					}
				}
				found = true
				break
			}
		}
		if !found {
			return ErrNotFound
		}
		if len(views) <= 1 {
			return ErrConflict
		}
		tag, err := tx.Exec(ctx, `DELETE FROM bt_views WHERE base_id=$1 AND id=$2`, baseID, viewID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrConflict
		}
		if err = pgViewReload(ctx, tx, baseID); err != nil {
			return err
		}
		if !guard.currentTime().Before(expiry) {
			return ErrUnauthenticated
		}
		return nil
	})
	if retryableRestoreConflict(err) {
		return ErrConflict
	}
	return err
}
