package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrPublicFormRateLimited = errors.New("store: public form rate limit exceeded")

const publicFormRateLimit = 20
const maxPublicFormRevision int64 = 9007199254740991

type formLink struct {
	hash          []byte
	revision      int64
	windowStarted time.Time
	windowCount   int
}

// Publication is authorized only against exactly the view configuration and
// complete schema the manager previewed. Prepare validates and freezes the
// effective public fields while the same storage lock is held.
type PublicFormPublishSnapshot struct {
	Config  json.RawMessage
	Fields  []Field
	Prepare func(View, []Field) (json.RawMessage, error)
}

func validPublicFormHash(hash []byte) bool { return len(hash) == 32 }

// SetPublicFormToken publishes, rotates or closes a form. An empty hash closes
// it; the raw bearer token is never stored. Only a manager may publish.
func (m *Memory) SetPublicFormToken(ctx context.Context, guard BaseWriteGuard, baseID, viewID, expectedRevision int64, hash []byte, snapshot *PublicFormPublishSnapshot) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	role, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return 0, err
	}
	if role != RoleManage {
		return 0, ErrForbidden
	}
	view, fields, err := m.readPublicFormLocked(ctx, baseID, viewID)
	if err != nil {
		return 0, err
	}
	if len(hash) != 0 && !validPublicFormHash(hash) {
		return 0, ErrInvalidBaseRecord
	}
	if !guard.currentTime().Before(expires) {
		return 0, ErrUnauthenticated
	}
	key := [2]int64{baseID, viewID}
	current := m.b.formLinks[key]
	if expectedRevision < 0 || expectedRevision != current.revision || current.revision >= maxPublicFormRevision {
		return 0, ErrConflict
	}
	var prepared json.RawMessage
	if len(hash) != 0 {
		if snapshot == nil || snapshot.Prepare == nil || !samePublicFormSnapshot(view, fields, snapshot.Config, snapshot.Fields) {
			return 0, ErrConflict
		}
		prepared, err = snapshot.Prepare(view, fields)
		if err != nil {
			return 0, err
		}
	}
	for other, link := range m.b.formLinks {
		if len(hash) != 0 && other != key && bytes.Equal(link.hash, hash) {
			return 0, ErrConflict
		}
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if !guard.currentTime().Before(expires) {
		return 0, ErrUnauthenticated
	}
	if m.b.formLinks == nil {
		m.b.formLinks = make(map[[2]int64]formLink)
	}
	if prepared != nil && !samePublicFormConfig(prepared, view.Config) {
		for i := range m.b.views {
			if m.b.views[i].ID == viewID && m.b.views[i].BaseID == baseID {
				m.b.views[i].Config = slices.Clone(prepared)
				break
			}
		}
		m.recordViewReloadLocked(baseID)
	}
	current = formLink{hash: slices.Clone(hash), revision: current.revision + 1, windowStarted: time.Now()}
	m.b.formLinks[key] = current
	return current.revision, nil
}

func (m *Memory) PublicFormPublished(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64) (bool, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	role, expires, err := m.checkBaseWriteLocked(guard, baseID)
	if err != nil {
		return false, 0, err
	}
	if role != RoleManage {
		return false, 0, ErrForbidden
	}
	if _, _, err := m.readPublicFormLocked(ctx, baseID, viewID); err != nil {
		return false, 0, err
	}
	if !guard.currentTime().Before(expires) {
		return false, 0, ErrUnauthenticated
	}
	link := m.b.formLinks[[2]int64{baseID, viewID}]
	return validPublicFormHash(link.hash), link.revision, nil
}

func (m *Memory) LookupPublicForm(ctx context.Context, hash []byte) (int64, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return 0, 0, err
	}
	if !validPublicFormHash(hash) {
		return 0, 0, ErrNotFound
	}
	for key, link := range m.b.formLinks {
		if bytes.Equal(link.hash, hash) {
			if _, _, err := m.readPublicFormLocked(ctx, key[0], key[1]); err != nil {
				return 0, 0, err
			}
			return key[0], key[1], nil
		}
	}
	return 0, 0, ErrNotFound
}

// PublicFormValidator checks an anonymous submission against the latest view
// and schema. It runs under the store lock and must not perform I/O.
type PublicFormValidator func(View, []Field) (map[string]json.RawMessage, error)

func (m *Memory) readPublicFormLocked(ctx context.Context, baseID, viewID int64) (View, []Field, error) {
	if err := ctx.Err(); err != nil {
		return View{}, nil, err
	}
	doc := m.doc(baseID)
	if doc == nil || doc.deleted || doc.meta.Kind != "base" {
		return View{}, nil, ErrNotFound
	}
	seen := map[int64]bool{}
	for current := doc; current != nil; {
		if seen[current.meta.ID] || current.deleted || current.meta.WorkspaceID != doc.meta.WorkspaceID {
			return View{}, nil, ErrNotFound
		}
		seen[current.meta.ID] = true
		if current.meta.ParentID == nil {
			break
		}
		current = m.doc(*current.meta.ParentID)
		if current == nil {
			return View{}, nil, ErrNotFound
		}
	}
	var view *View
	for _, candidate := range m.b.views {
		if candidate.BaseID == baseID && candidate.ID == viewID && candidate.Type == "form" {
			v := candidate
			v.Config = slices.Clone(v.Config)
			view = &v
			break
		}
	}
	if view == nil {
		return View{}, nil, ErrNotFound
	}
	fields := make([]Field, 0)
	for _, f := range m.b.fields {
		if f.BaseID == baseID {
			f.Options = slices.Clone(f.Options)
			f.OptionColors = slices.Clone(f.OptionColors)
			fields = append(fields, f)
		}
	}
	sort.Slice(fields, func(i, j int) bool {
		if fields[i].Position != fields[j].Position {
			return fields[i].Position < fields[j].Position
		}
		return fields[i].ID < fields[j].ID
	})
	return *view, fields, nil
}

func (m *Memory) ReadPublicForm(ctx context.Context, baseID, viewID int64, hash []byte) (View, []Field, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	link, ok := m.b.formLinks[[2]int64{baseID, viewID}]
	if !ok || !validPublicFormHash(hash) || !bytes.Equal(link.hash, hash) {
		return View{}, nil, ErrNotFound
	}
	return m.readPublicFormLocked(ctx, baseID, viewID)
}

func (m *Memory) SubmitPublicForm(ctx context.Context, baseID, viewID int64, hash []byte, validate PublicFormValidator) (Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if validate == nil {
		return Record{}, ErrInvalidBaseRecord
	}
	key := [2]int64{baseID, viewID}
	link, ok := m.b.formLinks[key]
	if !ok || !validPublicFormHash(hash) || !bytes.Equal(link.hash, hash) {
		return Record{}, ErrNotFound
	}
	view, fields, err := m.readPublicFormLocked(ctx, baseID, viewID)
	if err != nil {
		return Record{}, err
	}
	if time.Since(link.windowStarted) >= time.Minute {
		link.windowStarted = time.Now()
		link.windowCount = 0
	}
	if link.windowCount >= publicFormRateLimit {
		return Record{}, ErrPublicFormRateLimited
	}
	link.windowCount++
	m.b.formLinks[key] = link
	cells, err := validate(view, fields)
	if err != nil {
		return Record{}, err
	}
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	cloned := make(map[string]json.RawMessage, len(cells))
	for key, value := range cells {
		cloned[key] = slices.Clone(value)
	}
	now := time.Now()
	rec := Record{ID: m.id(), BaseID: baseID, Cells: cloned, CreatedAt: &now, UpdatedAt: &now}
	rec.Position = float64(rec.ID)
	body, err := recordEvent(baseID, "add", rec, 0)
	if err != nil {
		return Record{}, err
	}
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	m.b.records = append(m.b.records, rec)
	m.appendBtEventActorLocked(WithActor(ctx, Actor{Kind: "form"}), baseID, body)
	return rec, nil
}

func (p *Postgres) SetPublicFormToken(ctx context.Context, guard BaseWriteGuard, baseID, viewID, expectedRevision int64, hash []byte, snapshot *PublicFormPublishSnapshot) (revision int64, err error) {
	if len(hash) != 0 && !validPublicFormHash(hash) {
		return 0, ErrInvalidBaseRecord
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		role, expires, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		if role != RoleManage {
			return ErrForbidden
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bt_views WHERE base_id=$1 AND id=$2 AND type='form')`, baseID, viewID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		var view View
		var prepared json.RawMessage
		if len(hash) != 0 {
			if snapshot == nil || snapshot.Prepare == nil {
				return ErrConflict
			}
			if _, err := tx.Exec(ctx, `LOCK TABLE base_fields IN SHARE MODE`); err != nil {
				return err
			}
			var fields []Field
			view, fields, err = pgReadPublicFormLocked(ctx, tx, baseID, viewID)
			if err != nil {
				return err
			}
			if !samePublicFormSnapshot(view, fields, snapshot.Config, snapshot.Fields) {
				return ErrConflict
			}
			prepared, err = snapshot.Prepare(view, fields)
			if err != nil {
				return err
			}
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		// The empty state is persistent: even closing an unpublished form
		// advances the revision and fences any earlier in-flight publication.
		if _, err := tx.Exec(ctx, `INSERT INTO bt_public_form_links (base_id,view_id,token_hash,revision) VALUES ($1,$2,NULL,0) ON CONFLICT(view_id) DO NOTHING`, baseID, viewID); err != nil {
			return err
		}
		var current int64
		if err := tx.QueryRow(ctx, `SELECT revision FROM bt_public_form_links WHERE base_id=$1 AND view_id=$2 FOR UPDATE`, baseID, viewID).Scan(&current); err != nil {
			return err
		}
		if expectedRevision < 0 || expectedRevision != current || current >= maxPublicFormRevision {
			return ErrConflict
		}
		var nextHash []byte
		if len(hash) != 0 {
			nextHash = hash
		}
		if err := tx.QueryRow(ctx, `UPDATE bt_public_form_links SET token_hash=$3,revision=revision+1,window_started=now(),window_count=0 WHERE base_id=$1 AND view_id=$2 RETURNING revision`, baseID, viewID, nextHash).Scan(&revision); err != nil {
			return err
		}
		if prepared != nil && !samePublicFormConfig(prepared, view.Config) {
			if _, err := tx.Exec(ctx, `UPDATE bt_views SET config=$3 WHERE base_id=$1 AND id=$2`, baseID, viewID, prepared); err != nil {
				return err
			}
			if err := pgViewReload(ctx, tx, baseID); err != nil {
				return err
			}
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return revision, nil
}

func (p *Postgres) PublicFormPublished(ctx context.Context, guard BaseWriteGuard, baseID, viewID int64) (published bool, revision int64, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		role, expires, err := lockBaseWrite(ctx, tx, guard, baseID)
		if err != nil {
			return err
		}
		if role != RoleManage {
			return ErrForbidden
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bt_views WHERE base_id=$1 AND id=$2 AND type='form')`, baseID, viewID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		err = tx.QueryRow(ctx, `SELECT token_hash IS NOT NULL,revision FROM bt_public_form_links WHERE base_id=$1 AND view_id=$2`, baseID, viewID).Scan(&published, &revision)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if !guard.currentTime().Before(expires) {
			return ErrUnauthenticated
		}
		return nil
	})
	return published, revision, err
}

func (p *Postgres) LookupPublicForm(ctx context.Context, hash []byte) (baseID, viewID int64, err error) {
	if !validPublicFormHash(hash) {
		return 0, 0, ErrNotFound
	}
	err = p.Pool.QueryRow(ctx, `SELECT l.base_id,l.view_id FROM bt_public_form_links l
		JOIN nodes n ON n.id=l.base_id AND n.kind='base' AND n.deleted_at IS NULL
		JOIN bt_views v ON v.id=l.view_id AND v.base_id=l.base_id AND v.type='form'
		WHERE l.token_hash=$1`, hash).Scan(&baseID, &viewID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, ErrNotFound
	}
	return baseID, viewID, err
}

func pgReadPublicFormLocked(ctx context.Context, tx pgx.Tx, baseID, viewID int64) (View, []Field, error) {
	var validBase bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM nodes WHERE id=$1 AND kind='base' AND deleted_at IS NULL)`, baseID).Scan(&validBase); err != nil {
		return View{}, nil, err
	}
	if !validBase {
		return View{}, nil, ErrNotFound
	}
	var invalid bool
	if err := tx.QueryRow(ctx, `WITH RECURSIVE a AS (
			SELECT id,parent_id,workspace_id,deleted_at,ARRAY[id] AS seen,false AS cycle FROM nodes WHERE id=$1
			UNION ALL SELECT n.id,n.parent_id,n.workspace_id,n.deleted_at,a.seen||n.id,n.id=ANY(a.seen)
			FROM nodes n JOIN a ON n.id=a.parent_id WHERE NOT a.cycle
		) SELECT EXISTS(SELECT 1 FROM a WHERE deleted_at IS NOT NULL OR cycle OR workspace_id<>(SELECT workspace_id FROM nodes WHERE id=$1))
			OR EXISTS(SELECT 1 FROM a WHERE parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id=a.parent_id))`, baseID).Scan(&invalid); err != nil {
		return View{}, nil, err
	}
	if invalid {
		return View{}, nil, ErrNotFound
	}
	var view View
	err := tx.QueryRow(ctx, `SELECT id,base_id,type,name,config,pos FROM bt_views WHERE base_id=$1 AND id=$2 AND type='form'`, baseID, viewID).
		Scan(&view.ID, &view.BaseID, &view.Type, &view.Name, &view.Config, &view.Pos)
	if errors.Is(err, pgx.ErrNoRows) {
		return View{}, nil, ErrNotFound
	}
	if err != nil {
		return View{}, nil, err
	}
	fields, err := pgRecordFields(ctx, tx, baseID)
	if err != nil {
		return View{}, nil, err
	}
	return view, fields, nil
}

func (p *Postgres) ReadPublicForm(ctx context.Context, baseID, viewID int64, hash []byte) (view View, fields []Field, err error) {
	if !validPublicFormHash(hash) {
		return View{}, nil, ErrNotFound
	}
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return View{}, nil, err
	}
	defer tx.Rollback(ctx)
	var allowed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bt_public_form_links WHERE base_id=$1 AND view_id=$2 AND token_hash=$3)`, baseID, viewID, hash).Scan(&allowed); err != nil {
		return View{}, nil, err
	}
	if !allowed {
		return View{}, nil, ErrNotFound
	}
	view, fields, err = pgReadPublicFormLocked(ctx, tx, baseID, viewID)
	if err != nil {
		return View{}, nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return View{}, nil, err
	}
	return view, fields, nil
}

// Consume quota in its own bounded statement before the record transaction.
// Otherwise a validation error, database error or canceled write could roll
// back the counter and let a leaked capability repeatedly acquire table locks.
func (p *Postgres) consumePublicFormQuota(ctx context.Context, baseID, viewID int64, hash []byte) error {
	quotaCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	var count int
	err := p.Pool.QueryRow(quotaCtx, `UPDATE bt_public_form_links SET
		window_count=CASE WHEN window_started<=clock_timestamp()-interval '1 minute' THEN 1 ELSE window_count+1 END,
		window_started=CASE WHEN window_started<=clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE window_started END
		WHERE base_id=$1 AND view_id=$2 AND token_hash=$3
		AND (window_count<$4 OR window_started<=clock_timestamp()-interval '1 minute') RETURNING window_count`, baseID, viewID, hash, publicFormRateLimit).Scan(&count)
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var exists bool
	if err := p.Pool.QueryRow(quotaCtx, `SELECT EXISTS(SELECT 1 FROM bt_public_form_links WHERE base_id=$1 AND view_id=$2 AND token_hash=$3)`, baseID, viewID, hash).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return ErrPublicFormRateLimited
}

func (p *Postgres) SubmitPublicForm(ctx context.Context, baseID, viewID int64, hash []byte, validate PublicFormValidator) (result Record, err error) {
	if validate == nil {
		return Record{}, ErrInvalidBaseRecord
	}
	if !validPublicFormHash(hash) {
		return Record{}, ErrNotFound
	}
	if err := p.consumePublicFormQuota(ctx, baseID, viewID, hash); err != nil {
		return Record{}, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		if err := lockBaseNode(ctx, tx, baseID); err != nil {
			return err
		}
		// Publication and revocation use the same Base lock; a request that
		// was looked up before revocation cannot submit after it commits.
		var allowed bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bt_public_form_links WHERE base_id=$1 AND view_id=$2 AND token_hash=$3)`, baseID, viewID, hash).Scan(&allowed); err != nil {
			return err
		}
		if !allowed {
			return ErrNotFound
		}
		// Match the order used by guarded field, record and CSV writes.
		if _, err := tx.Exec(ctx, `LOCK TABLE base_fields,base_records,bt_links IN SHARE ROW EXCLUSIVE MODE`); err != nil {
			return err
		}
		view, fields, err := pgReadPublicFormLocked(ctx, tx, baseID, viewID)
		if err != nil {
			return err
		}
		cells, err := validate(view, fields)
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		result, err = scanRecord(tx.QueryRow(ctx, `INSERT INTO base_records (base_id,cells,position) VALUES ($1,$2,COALESCE((SELECT max(position) FROM base_records WHERE base_id=$1),0)+1) RETURNING `+recordCols, baseID, cells))
		if err != nil {
			return err
		}
		body, err := recordEvent(baseID, "add", result, 0)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO bt_events (base_id,body,actor_kind) VALUES ($1,$2,'form')`, baseID, body)
		return err
	})
	if err != nil {
		return Record{}, err
	}
	return result, nil
}
