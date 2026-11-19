package store

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const (
	baseMaxDashboards       = 20
	baseMaxDashboardWidgets = 30
)

// DashboardWidget defines one persisted chart/KPI card on a Base dashboard.
type DashboardWidget struct {
	ID           string `json:"id"`
	Type         string `json:"type"` // metric | bar | horizontal_bar | pie | line | pivot
	Title        string `json:"title"`
	TableID      int64  `json:"tableId,omitempty"`
	Span         int    `json:"span"` // 1 | 2
	GroupFieldID int64  `json:"groupFieldId,omitempty"`
	Metric       string `json:"metric"` // count | sum | avg | min | max | checked_pct
	ValueFieldID int64  `json:"valueFieldId,omitempty"`
}

// BaseDashboard is a persisted multi-widget dashboard belonging to a Base.
type BaseDashboard struct {
	ID        int64             `json:"id"`
	BaseID    int64             `json:"baseId"`
	Name      string            `json:"name"`
	Widgets   []DashboardWidget `json:"widgets"`
	Revision  int64             `json:"revision"`
	UpdatedBy *int64            `json:"updatedBy,omitempty"`
	CreatedAt time.Time         `json:"createdAt"`
	UpdatedAt time.Time         `json:"updatedAt"`
}

// BaseDashboardStore manages persisted multi-widget dashboards with PG/Memory parity.
type BaseDashboardStore interface {
	ListBaseDashboards(ctx context.Context, userID, baseID int64) ([]BaseDashboard, error)
	CreateBaseDashboardGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, name string, widgets []DashboardWidget) (BaseDashboard, error)
	UpdateBaseDashboardGuarded(ctx context.Context, guard BaseWriteGuard, baseID, dashboardID int64, name *string, widgets *[]DashboardWidget, expectedRevision *int64) (BaseDashboard, error)
	DeleteBaseDashboardGuarded(ctx context.Context, guard BaseWriteGuard, baseID, dashboardID int64) error
}

func cleanDashboardName(raw string) (string, bool) {
	name := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(name)
	if n == 0 || n > 60 || !utf8.ValidString(name) {
		return "", false
	}
	return name, true
}

func validateAndNormalizeDashboardWidgets(widgets []DashboardWidget) ([]DashboardWidget, bool) {
	if len(widgets) > baseMaxDashboardWidgets {
		return nil, false
	}
	out := make([]DashboardWidget, 0, len(widgets))
	seen := make(map[string]bool, len(widgets))
	for _, w := range widgets {
		id := strings.TrimSpace(w.ID)
		if id == "" || utf8.RuneCountInString(id) > 64 || seen[id] {
			return nil, false
		}
		seen[id] = true
		switch w.Type {
		case "metric", "bar", "horizontal_bar", "pie", "line", "pivot":
		default:
			return nil, false
		}
		metric := w.Metric
		if metric == "" {
			metric = "count"
		}
		switch metric {
		case "count", "sum", "avg", "min", "max", "checked_pct":
		default:
			return nil, false
		}
		title := strings.TrimSpace(w.Title)
		if title == "" {
			title = "图表"
		}
		if utf8.RuneCountInString(title) > 80 || !utf8.ValidString(title) {
			return nil, false
		}
		span := w.Span
		if span != 2 {
			span = 1
		}
		if w.TableID < 0 || w.GroupFieldID < 0 || w.ValueFieldID < 0 {
			return nil, false
		}
		out = append(out, DashboardWidget{
			ID:           id,
			Type:         w.Type,
			Title:        title,
			TableID:      w.TableID,
			Span:         span,
			GroupFieldID: w.GroupFieldID,
			Metric:       metric,
			ValueFieldID: w.ValueFieldID,
		})
	}
	return out, true
}

func cloneBaseDashboard(d BaseDashboard) BaseDashboard {
	d.Widgets = slices.Clone(d.Widgets)
	if d.Widgets == nil {
		d.Widgets = []DashboardWidget{}
	}
	if d.UpdatedBy != nil {
		v := *d.UpdatedBy
		d.UpdatedBy = &v
	}
	return d
}

// RemapDashboardWidgets rewrites tableId/groupFieldId/valueFieldId when duplicating a Base.
func RemapDashboardWidgets(widgets []DashboardWidget, tableMap, fieldMap map[int64]int64) []DashboardWidget {
	out := make([]DashboardWidget, 0, len(widgets))
	for _, w := range widgets {
		nw := w
		if w.TableID > 0 {
			if mapped, ok := tableMap[w.TableID]; ok {
				nw.TableID = mapped
			} else {
				nw.TableID = 0
			}
		}
		if w.GroupFieldID > 0 {
			if mapped, ok := fieldMap[w.GroupFieldID]; ok {
				nw.GroupFieldID = mapped
			} else {
				nw.GroupFieldID = 0
			}
		}
		if w.ValueFieldID > 0 {
			if mapped, ok := fieldMap[w.ValueFieldID]; ok {
				nw.ValueFieldID = mapped
			} else {
				nw.ValueFieldID = 0
			}
		}
		out = append(out, nw)
	}
	return out
}

func (m *Memory) ListBaseDashboards(ctx context.Context, userID, baseID int64) ([]BaseDashboard, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.doc(baseID)
	if d == nil || d.deleted || d.meta.Kind != "base" {
		return nil, ErrNotFound
	}
	if RoleRank(m.roleLocked(userID, d)) < RoleRank(RoleView) {
		return nil, ErrForbidden
	}
	out := make([]BaseDashboard, 0)
	for _, db := range m.baseDashboards {
		if db.BaseID == baseID {
			out = append(out, cloneBaseDashboard(db))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) CreateBaseDashboardGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, rawName string, widgets []DashboardWidget) (BaseDashboard, error) {
	if err := ctx.Err(); err != nil {
		return BaseDashboard{}, err
	}
	name, ok := cleanDashboardName(rawName)
	if !ok {
		return BaseDashboard{}, ErrConflict
	}
	normWidgets, ok := validateAndNormalizeDashboardWidgets(widgets)
	if !ok {
		return BaseDashboard{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return BaseDashboard{}, err
	}
	count := 0
	for _, db := range m.baseDashboards {
		if db.BaseID == baseID {
			count++
		}
	}
	if count >= baseMaxDashboards {
		return BaseDashboard{}, ErrConflict
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return BaseDashboard{}, err
	}
	m.baseDashboardSeq++
	now := time.Now()
	uid := guard.UserID
	db := BaseDashboard{
		ID:        m.baseDashboardSeq,
		BaseID:    baseID,
		Name:      name,
		Widgets:   normWidgets,
		Revision:  1,
		UpdatedBy: &uid,
		CreatedAt: now,
		UpdatedAt: now,
	}
	m.baseDashboards = append(m.baseDashboards, db)
	m.appendBtEventActorLocked(ctx, baseID, []byte(`{"kind":"reload"}`))
	return cloneBaseDashboard(db), nil
}

func (m *Memory) UpdateBaseDashboardGuarded(ctx context.Context, guard BaseWriteGuard, baseID, dashboardID int64, name *string, widgets *[]DashboardWidget, expectedRevision *int64) (BaseDashboard, error) {
	if err := ctx.Err(); err != nil {
		return BaseDashboard{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return BaseDashboard{}, err
	}
	idx := -1
	for i := range m.baseDashboards {
		if m.baseDashboards[i].ID == dashboardID && m.baseDashboards[i].BaseID == baseID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return BaseDashboard{}, ErrNotFound
	}
	cur := m.baseDashboards[idx]
	if expectedRevision != nil && cur.Revision != *expectedRevision {
		return BaseDashboard{}, ErrConflict
	}
	nextName := cur.Name
	if name != nil {
		clean, ok := cleanDashboardName(*name)
		if !ok {
			return BaseDashboard{}, ErrConflict
		}
		nextName = clean
	}
	nextWidgets := cur.Widgets
	if widgets != nil {
		norm, ok := validateAndNormalizeDashboardWidgets(*widgets)
		if !ok {
			return BaseDashboard{}, ErrConflict
		}
		nextWidgets = norm
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return BaseDashboard{}, err
	}
	uid := guard.UserID
	cur.Name = nextName
	cur.Widgets = nextWidgets
	cur.Revision++
	cur.UpdatedBy = &uid
	cur.UpdatedAt = time.Now()
	m.baseDashboards[idx] = cur
	m.appendBtEventActorLocked(ctx, baseID, []byte(`{"kind":"reload"}`))
	return cloneBaseDashboard(cur), nil
}

func (m *Memory) DeleteBaseDashboardGuarded(ctx context.Context, guard BaseWriteGuard, baseID, dashboardID int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return err
	}
	idx := -1
	for i := range m.baseDashboards {
		if m.baseDashboards[i].ID == dashboardID && m.baseDashboards[i].BaseID == baseID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	m.baseDashboards = append(m.baseDashboards[:idx], m.baseDashboards[idx+1:]...)
	m.appendBtEventActorLocked(ctx, baseID, []byte(`{"kind":"reload"}`))
	return nil
}

func scanBaseDashboardPG(row pgx.Row) (BaseDashboard, error) {
	var db BaseDashboard
	var widgetsRaw []byte
	if err := row.Scan(&db.ID, &db.BaseID, &db.Name, &widgetsRaw, &db.Revision, &db.UpdatedBy, &db.CreatedAt, &db.UpdatedAt); err != nil {
		return BaseDashboard{}, err
	}
	db.Widgets = []DashboardWidget{}
	if len(widgetsRaw) > 0 {
		if err := json.Unmarshal(widgetsRaw, &db.Widgets); err != nil {
			return BaseDashboard{}, err
		}
	}
	return db, nil
}

func (p *Postgres) ListBaseDashboards(ctx context.Context, userID, baseID int64) ([]BaseDashboard, error) {
	meta, err := p.GetDoc(ctx, userID, baseID)
	if err != nil {
		return nil, err
	}
	if meta.Kind != "base" {
		return nil, ErrNotFound
	}
	if RoleRank(meta.Role) < RoleRank(RoleView) {
		return nil, ErrForbidden
	}
	rows, err := p.Pool.Query(ctx, `
		SELECT id, base_id, name, widgets, revision, updated_by, created_at, updated_at
		FROM bt_dashboards
		WHERE base_id = $1
		ORDER BY id ASC
	`, baseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]BaseDashboard, 0)
	for rows.Next() {
		db, err := scanBaseDashboardPG(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, db)
	}
	return out, rows.Err()
}

func (p *Postgres) CreateBaseDashboardGuarded(ctx context.Context, guard BaseWriteGuard, baseID int64, rawName string, widgets []DashboardWidget) (out BaseDashboard, err error) {
	name, ok := cleanDashboardName(rawName)
	if !ok {
		return out, ErrConflict
	}
	normWidgets, ok := validateAndNormalizeDashboardWidgets(widgets)
	if !ok {
		return out, ErrConflict
	}
	widgetsJSON, err := json.Marshal(normWidgets)
	if err != nil {
		return out, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockBaseWrite(ctx, tx, guard, baseID)
		if e != nil {
			return e
		}
		var count int
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM bt_dashboards WHERE base_id=$1`, baseID).Scan(&count); e != nil {
			return e
		}
		if count >= baseMaxDashboards {
			return ErrConflict
		}
		out, e = scanBaseDashboardPG(tx.QueryRow(ctx, `
			INSERT INTO bt_dashboards (base_id, name, widgets, revision, updated_by)
			VALUES ($1, $2, $3::jsonb, 1, $4)
			RETURNING id, base_id, name, widgets, revision, updated_by, created_at, updated_at
		`, baseID, name, string(widgetsJSON), guard.UserID))
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO bt_events(base_id, body, actor_id, actor_kind) VALUES ($1, '{"kind":"reload"}'::jsonb, $2, 'user')`, baseID, guard.UserID); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) UpdateBaseDashboardGuarded(ctx context.Context, guard BaseWriteGuard, baseID, dashboardID int64, name *string, widgets *[]DashboardWidget, expectedRevision *int64) (out BaseDashboard, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockBaseWrite(ctx, tx, guard, baseID)
		if e != nil {
			return e
		}
		cur, e := scanBaseDashboardPG(tx.QueryRow(ctx, `
			SELECT id, base_id, name, widgets, revision, updated_by, created_at, updated_at
			FROM bt_dashboards
			WHERE id=$1 AND base_id=$2
			FOR UPDATE
		`, dashboardID, baseID))
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if expectedRevision != nil && cur.Revision != *expectedRevision {
			return ErrConflict
		}
		nextName := cur.Name
		if name != nil {
			clean, ok := cleanDashboardName(*name)
			if !ok {
				return ErrConflict
			}
			nextName = clean
		}
		nextWidgets := cur.Widgets
		if widgets != nil {
			norm, ok := validateAndNormalizeDashboardWidgets(*widgets)
			if !ok {
				return ErrConflict
			}
			nextWidgets = norm
		}
		widgetsJSON, e := json.Marshal(nextWidgets)
		if e != nil {
			return e
		}
		out, e = scanBaseDashboardPG(tx.QueryRow(ctx, `
			UPDATE bt_dashboards
			SET name=$3, widgets=$4::jsonb, revision=revision+1, updated_by=$5, updated_at=now()
			WHERE id=$1 AND base_id=$2
			RETURNING id, base_id, name, widgets, revision, updated_by, created_at, updated_at
		`, dashboardID, baseID, nextName, string(widgetsJSON), guard.UserID))
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO bt_events(base_id, body, actor_id, actor_kind) VALUES ($1, '{"kind":"reload"}'::jsonb, $2, 'user')`, baseID, guard.UserID); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) DeleteBaseDashboardGuarded(ctx context.Context, guard BaseWriteGuard, baseID, dashboardID int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := lockBaseWrite(ctx, tx, guard, baseID)
		if e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `DELETE FROM bt_dashboards WHERE id=$1 AND base_id=$2`, dashboardID, baseID)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		if _, e = tx.Exec(ctx, `INSERT INTO bt_events(base_id, body, actor_id, actor_kind) VALUES ($1, '{"kind":"reload"}'::jsonb, $2, 'user')`, baseID, guard.UserID); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return drivePGError(err)
}
