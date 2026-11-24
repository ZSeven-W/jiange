package store

import (
	"bytes"
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
	slidesCommentMaxRunes       = 2000
	slidesShapeIDMaxRunes       = 64
	slidesVersionLabelMaxRunes  = 120
	slidesVersionsMaxLimit      = 100
	slidesPreRestoreBackupLabel = "恢复前自动备份"
	slidesDefaultAutoLabel      = "自动备份"
	slidesDefaultManualLabel    = "未命名版本"
)

// SlidesComment is a page- or shape-anchored review comment on a presentation deck.
type SlidesComment struct {
	ID         int64     `json:"id"`
	SlidesID   int64     `json:"slidesId"`
	PageID     int64     `json:"pageId"`
	ShapeID    string    `json:"shapeId"`
	AuthorID   int64     `json:"authorId"`
	AuthorName string    `json:"authorName"`
	Body       string    `json:"body"`
	Resolved   bool      `json:"resolved"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// SlidesVersionMeta describes a persisted presentation deck snapshot in slides_versions.
type SlidesVersionMeta struct {
	ID        int64     `json:"id"`
	SlidesID  int64     `json:"slidesId"`
	Label     string    `json:"label"`
	AutoSaved bool      `json:"autoSaved"`
	CreatedBy int64     `json:"createdBy"`
	ActorName string    `json:"actorName"`
	CreatedAt time.Time `json:"createdAt"`
	PageCount int       `json:"pageCount"`
}

// SlidesVersionSnapshot stores an ordered full-fidelity deck snapshot including page metadata.
type SlidesVersionSnapshot struct {
	Pages []SlidesPage `json:"pages"`
}

// SlidesExtrasStore manages Slides review comments and deck version snapshots with PG/Memory parity.
type SlidesExtrasStore interface {
	ListSlidesComments(ctx context.Context, guard RestoreGuard, slidesID int64) ([]SlidesComment, error)
	CreateSlidesCommentGuarded(ctx context.Context, guard RestoreGuard, slidesID, pageID int64, shapeID, body string) (SlidesComment, error)
	UpdateSlidesCommentGuarded(ctx context.Context, guard RestoreGuard, slidesID, commentID int64, body *string, resolved *bool) (SlidesComment, error)
	DeleteSlidesCommentGuarded(ctx context.Context, guard RestoreGuard, slidesID, commentID int64) error
	ListSlidesVersions(ctx context.Context, guard RestoreGuard, slidesID int64) ([]SlidesVersionMeta, error)
	CreateSlidesVersionGuarded(ctx context.Context, guard RestoreGuard, slidesID int64, label string, autoSaved bool) (SlidesVersionMeta, error)
	RestoreSlidesVersionGuarded(ctx context.Context, guard RestoreGuard, slidesID, versionID int64) ([]SlidesPage, error)
}

var (
	_ SlidesExtrasStore = (*Memory)(nil)
	_ SlidesExtrasStore = (*Postgres)(nil)
)

type memSlidesVersion struct {
	meta     SlidesVersionMeta
	snapshot []byte
}

// memSlidesExtras holds in-memory slides comments and version snapshots for Memory store.
type memSlidesExtras struct {
	nextCommentID int64
	nextVersionID int64
	comments      map[int64][]SlidesComment
	versions      map[int64][]memSlidesVersion
}

func cleanSlidesCommentBody(raw string) (string, bool) {
	b := strings.TrimSpace(raw)
	if !utf8.ValidString(b) || strings.ContainsRune(b, '\x00') {
		return "", false
	}
	n := utf8.RuneCountInString(b)
	if n == 0 || n > slidesCommentMaxRunes {
		return "", false
	}
	return b, true
}

func cleanSlidesShapeID(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", true
	}
	if !utf8.ValidString(s) || strings.ContainsRune(s, '\x00') {
		return "", false
	}
	if utf8.RuneCountInString(s) > slidesShapeIDMaxRunes {
		return "", false
	}
	return s, true
}

func normalizeSlidesVersionLabel(raw string, autoSaved bool) (string, bool) {
	label := strings.TrimSpace(raw)
	if !utf8.ValidString(label) || strings.ContainsRune(label, '\x00') {
		return "", false
	}
	if utf8.RuneCountInString(label) > slidesVersionLabelMaxRunes {
		return "", false
	}
	if label == "" {
		if autoSaved {
			return slidesDefaultAutoLabel, true
		}
		return slidesDefaultManualLabel, true
	}
	return label, true
}

func normalizeSlidesShapesJSON(raw json.RawMessage) (json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return json.RawMessage(`[]`), true
	}
	if trimmed[0] != '[' || !json.Valid(trimmed) {
		return nil, false
	}
	return slices.Clone(trimmed), true
}

func sortSlidesSnapshotPages(pages []SlidesPage) []SlidesPage {
	ordered := slices.Clone(pages)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].Pos != ordered[j].Pos {
			return ordered[i].Pos < ordered[j].Pos
		}
		if ordered[i].ID != ordered[j].ID {
			return ordered[i].ID < ordered[j].ID
		}
		return false
	})
	return ordered
}

func sanitizeRestoredSlidesPages(snap SlidesVersionSnapshot) ([]SlidesPage, error) {
	if snap.Pages == nil {
		return nil, ErrConflict
	}
	ordered := sortSlidesSnapshotPages(snap.Pages)
	clean := make([]SlidesPage, len(ordered))
	for i, pg := range ordered {
		if !ValidSlideLayout(pg.Layout) {
			return nil, ErrConflict
		}
		shapes, ok := normalizeSlidesShapesJSON(pg.Shapes)
		if !ok {
			return nil, ErrConflict
		}
		pg.Shapes = shapes
		pg.Meta = normalizeDBSlideMeta(pg.Meta)
		if len(pg.Meta) > 0 && !json.Valid(pg.Meta) {
			return nil, ErrConflict
		}
		clean[i] = pg
	}
	return clean, nil
}

// --- Memory implementation ---

func (m *Memory) ensureSlidesExtrasMapsLocked() {
	if m.slidesExtras.comments == nil {
		m.slidesExtras.comments = map[int64][]SlidesComment{}
	}
	if m.slidesExtras.versions == nil {
		m.slidesExtras.versions = map[int64][]memSlidesVersion{}
	}
}

func (m *Memory) authorizeSlidesExtrasLocked(ctx context.Context, g RestoreGuard, slidesID int64, minRole string) (*memDoc, string, time.Time, error) {
	expires, err := m.driveSessionLocked(ctx, g)
	if err != nil {
		return nil, "", time.Time{}, err
	}
	if slidesID <= 0 {
		return nil, "", time.Time{}, ErrNotFound
	}
	d := m.doc(slidesID)
	if d == nil || d.deleted || d.purged || d.meta.Kind != "slides" {
		return nil, "", time.Time{}, ErrNotFound
	}
	role := m.roleLocked(g.UserID, d)
	if RoleRank(role) < RoleRank(RoleView) || !m.driveValidChainLocked(d, d.meta.WorkspaceID, false) {
		return nil, "", time.Time{}, ErrNotFound
	}
	if RoleRank(role) < RoleRank(minRole) {
		return nil, "", time.Time{}, ErrForbidden
	}
	return d, role, expires, nil
}

func (m *Memory) slidesPagesSnapshotLocked(slidesID int64) SlidesVersionSnapshot {
	pages := make([]SlidesPage, 0)
	for _, p := range m.slides {
		if p.SlidesID != slidesID {
			continue
		}
		shapes, ok := normalizeSlidesShapesJSON(p.Shapes)
		if !ok {
			shapes = json.RawMessage(`[]`)
		}
		p.Shapes = shapes
		p.Meta = cloneSlideMeta(p.Meta)
		pages = append(pages, p)
	}
	sort.Slice(pages, func(i, j int) bool {
		if pages[i].Pos == pages[j].Pos {
			return pages[i].ID < pages[j].ID
		}
		return pages[i].Pos < pages[j].Pos
	})
	return SlidesVersionSnapshot{Pages: pages}
}

func (m *Memory) ListSlidesComments(ctx context.Context, guard RestoreGuard, slidesID int64) ([]SlidesComment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, _, expires, err := m.authorizeSlidesExtrasLocked(ctx, guard, slidesID, RoleView)
	if err != nil {
		return nil, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	list := m.slidesExtras.comments[slidesID]
	if len(list) == 0 {
		return []SlidesComment{}, nil
	}
	out := slices.Clone(list)
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (m *Memory) CreateSlidesCommentGuarded(ctx context.Context, guard RestoreGuard, slidesID, pageID int64, shapeID, body string) (SlidesComment, error) {
	cleanBody, ok := cleanSlidesCommentBody(body)
	if !ok {
		return SlidesComment{}, ErrConflict
	}
	cleanShape, ok := cleanSlidesShapeID(shapeID)
	if !ok {
		return SlidesComment{}, ErrConflict
	}
	if pageID <= 0 {
		return SlidesComment{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, _, expires, err := m.authorizeSlidesExtrasLocked(ctx, guard, slidesID, RoleView)
	if err != nil {
		return SlidesComment{}, err
	}
	_, pg := m.findSlidesPageLocked(pageID)
	if pg == nil || pg.SlidesID != slidesID {
		return SlidesComment{}, ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return SlidesComment{}, err
	}
	m.ensureSlidesExtrasMapsLocked()
	m.slidesExtras.nextCommentID++
	now := guard.currentTime().UTC()
	cm := SlidesComment{
		ID:         m.slidesExtras.nextCommentID,
		SlidesID:   slidesID,
		PageID:     pageID,
		ShapeID:    cleanShape,
		AuthorID:   guard.UserID,
		AuthorName: m.actorNameLocked(guard.UserID),
		Body:       cleanBody,
		Resolved:   false,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	m.slidesExtras.comments[slidesID] = append(m.slidesExtras.comments[slidesID], cm)
	return cm, nil
}

func (m *Memory) UpdateSlidesCommentGuarded(ctx context.Context, guard RestoreGuard, slidesID, commentID int64, body *string, resolved *bool) (SlidesComment, error) {
	if commentID <= 0 {
		return SlidesComment{}, ErrNotFound
	}
	if body == nil && resolved == nil {
		return SlidesComment{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, role, expires, err := m.authorizeSlidesExtrasLocked(ctx, guard, slidesID, RoleView)
	if err != nil {
		return SlidesComment{}, err
	}
	list := m.slidesExtras.comments[slidesID]
	idx := -1
	for i := range list {
		if list[i].ID == commentID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return SlidesComment{}, ErrNotFound
	}
	cm := list[idx]
	if body != nil {
		if cm.AuthorID != guard.UserID && RoleRank(role) < RoleRank(RoleManage) {
			return SlidesComment{}, ErrForbidden
		}
		cleanBody, ok := cleanSlidesCommentBody(*body)
		if !ok {
			return SlidesComment{}, ErrConflict
		}
		cm.Body = cleanBody
	}
	if resolved != nil {
		if cm.AuthorID != guard.UserID && RoleRank(role) < RoleRank(RoleEdit) {
			return SlidesComment{}, ErrForbidden
		}
		cm.Resolved = *resolved
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return SlidesComment{}, err
	}
	cm.UpdatedAt = guard.currentTime().UTC()
	list[idx] = cm
	return cm, nil
}

func (m *Memory) DeleteSlidesCommentGuarded(ctx context.Context, guard RestoreGuard, slidesID, commentID int64) error {
	if commentID <= 0 {
		return ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, role, expires, err := m.authorizeSlidesExtrasLocked(ctx, guard, slidesID, RoleView)
	if err != nil {
		return err
	}
	list := m.slidesExtras.comments[slidesID]
	idx := -1
	for i := range list {
		if list[i].ID == commentID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrNotFound
	}
	if list[idx].AuthorID != guard.UserID && RoleRank(role) < RoleRank(RoleManage) {
		return ErrForbidden
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	m.slidesExtras.comments[slidesID] = append(list[:idx], list[idx+1:]...)
	return nil
}

func (m *Memory) ListSlidesVersions(ctx context.Context, guard RestoreGuard, slidesID int64) ([]SlidesVersionMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, _, expires, err := m.authorizeSlidesExtrasLocked(ctx, guard, slidesID, RoleView)
	if err != nil {
		return nil, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	list := m.slidesExtras.versions[slidesID]
	if len(list) == 0 {
		return []SlidesVersionMeta{}, nil
	}
	ordered := make([]SlidesVersionMeta, len(list))
	for i, item := range list {
		ordered[i] = item.meta
	}
	sort.Slice(ordered, func(i, j int) bool {
		if !ordered[i].CreatedAt.Equal(ordered[j].CreatedAt) {
			return ordered[i].CreatedAt.After(ordered[j].CreatedAt)
		}
		return ordered[i].ID > ordered[j].ID
	})
	if len(ordered) > slidesVersionsMaxLimit {
		ordered = ordered[:slidesVersionsMaxLimit]
	}
	return ordered, nil
}

func (m *Memory) CreateSlidesVersionGuarded(ctx context.Context, guard RestoreGuard, slidesID int64, label string, autoSaved bool) (SlidesVersionMeta, error) {
	cleanLabel, ok := normalizeSlidesVersionLabel(label, autoSaved)
	if !ok {
		return SlidesVersionMeta{}, ErrConflict
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, _, expires, err := m.authorizeSlidesExtrasLocked(ctx, guard, slidesID, RoleEdit)
	if err != nil {
		return SlidesVersionMeta{}, err
	}
	snap := m.slidesPagesSnapshotLocked(slidesID)
	rawSnap, err := json.Marshal(snap)
	if err != nil {
		return SlidesVersionMeta{}, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return SlidesVersionMeta{}, err
	}
	m.ensureSlidesExtrasMapsLocked()
	m.slidesExtras.nextVersionID++
	meta := SlidesVersionMeta{
		ID:        m.slidesExtras.nextVersionID,
		SlidesID:  slidesID,
		Label:     cleanLabel,
		AutoSaved: autoSaved,
		CreatedBy: guard.UserID,
		ActorName: m.actorNameLocked(guard.UserID),
		CreatedAt: guard.currentTime().UTC(),
		PageCount: len(snap.Pages),
	}
	m.slidesExtras.versions[slidesID] = append(m.slidesExtras.versions[slidesID], memSlidesVersion{
		meta:     meta,
		snapshot: rawSnap,
	})
	return meta, nil
}

func (m *Memory) RestoreSlidesVersionGuarded(ctx context.Context, guard RestoreGuard, slidesID, versionID int64) ([]SlidesPage, error) {
	if versionID <= 0 {
		return nil, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, _, expires, err := m.authorizeSlidesExtrasLocked(ctx, guard, slidesID, RoleEdit)
	if err != nil {
		return nil, err
	}
	var targetRaw []byte
	for _, v := range m.slidesExtras.versions[slidesID] {
		if v.meta.ID == versionID {
			targetRaw = v.snapshot
			break
		}
	}
	if len(targetRaw) == 0 {
		return nil, ErrNotFound
	}
	var targetSnap SlidesVersionSnapshot
	if err := json.Unmarshal(targetRaw, &targetSnap); err != nil {
		return nil, ErrConflict
	}
	restoredSrc, err := sanitizeRestoredSlidesPages(targetSnap)
	if err != nil {
		return nil, err
	}
	currentSnap := m.slidesPagesSnapshotLocked(slidesID)
	backupRaw, err := json.Marshal(currentSnap)
	if err != nil {
		return nil, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}

	// Automatically snapshot current deck state before restoring.
	m.ensureSlidesExtrasMapsLocked()
	m.slidesExtras.nextVersionID++
	now := guard.currentTime().UTC()
	backupMeta := SlidesVersionMeta{
		ID:        m.slidesExtras.nextVersionID,
		SlidesID:  slidesID,
		Label:     slidesPreRestoreBackupLabel,
		AutoSaved: true,
		CreatedBy: guard.UserID,
		ActorName: m.actorNameLocked(guard.UserID),
		CreatedAt: now,
		PageCount: len(currentSnap.Pages),
	}
	m.slidesExtras.versions[slidesID] = append(m.slidesExtras.versions[slidesID], memSlidesVersion{
		meta:     backupMeta,
		snapshot: backupRaw,
	})

	// Atomically replace deck pages preserving all content, layout, visibility, shapes, meta, and order.
	m.slides = slices.DeleteFunc(m.slides, func(p SlidesPage) bool { return p.SlidesID == slidesID })
	out := make([]SlidesPage, 0, len(restoredSrc))
	for i, src := range restoredSrc {
		m.slidesSequence++
		pg := SlidesPage{
			ID:         m.slidesSequence,
			SlidesID:   slidesID,
			Pos:        float64(i + 1),
			Title:      src.Title,
			Body:       src.Body,
			Background: src.Background,
			Layout:     src.Layout,
			Notes:      src.Notes,
			Shapes:     slices.Clone(src.Shapes),
			Meta:       cloneSlideMeta(src.Meta),
			Hidden:     src.Hidden,
			Revision:   1,
			UpdatedAt:  now,
		}
		m.slides = append(m.slides, pg)
		cloned := pg
		cloned.Shapes = slices.Clone(pg.Shapes)
		cloned.Meta = cloneSlideMeta(pg.Meta)
		out = append(out, cloned)
	}
	d.meta.UpdatedAt = now
	m.setDocumentModifierLocked(d, guard.UserID)
	return out, nil
}

// --- PostgreSQL implementation ---

func authorizeSlidesExtrasPG(ctx context.Context, tx pgx.Tx, g RestoreGuard, slidesID int64, minRole string, lockDeckForUpdate bool) (string, time.Time, error) {
	if slidesID <= 0 {
		return "", time.Time{}, ErrNotFound
	}
	if lockDeckForUpdate {
		// Lock existing page rows in stable id order before locking the deck node,
		// matching ReorderSlides and BatchUpdateSlidesPagesMeta to prevent deadlocks.
		lockRows, err := tx.Query(ctx, `SELECT id FROM slides_pages WHERE slides_id=$1 ORDER BY id FOR UPDATE`, slidesID)
		if err != nil {
			return "", time.Time{}, err
		}
		for lockRows.Next() {
			var id int64
			if err = lockRows.Scan(&id); err != nil {
				lockRows.Close()
				return "", time.Time{}, err
			}
		}
		if err = lockRows.Err(); err != nil {
			lockRows.Close()
			return "", time.Time{}, err
		}
		lockRows.Close()
	}
	expires, err := drivePGSession(ctx, tx, g)
	if err != nil {
		return "", time.Time{}, err
	}
	nodeLock := "FOR SHARE"
	if lockDeckForUpdate {
		nodeLock = "FOR UPDATE"
	}
	var workspaceID int64
	var kind string
	var deleted bool
	err = tx.QueryRow(ctx, `SELECT workspace_id, kind, deleted_at IS NOT NULL FROM nodes WHERE id=$1 `+nodeLock, slidesID).
		Scan(&workspaceID, &kind, &deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", time.Time{}, ErrNotFound
	}
	if err != nil {
		return "", time.Time{}, err
	}
	if kind != "slides" || deleted {
		return "", time.Time{}, ErrNotFound
	}
	if err = drivePGValidChain(ctx, tx, slidesID, workspaceID); err != nil {
		if errors.Is(err, ErrConflict) {
			return "", time.Time{}, ErrNotFound
		}
		return "", time.Time{}, err
	}
	role, _, _, err := lockCopySource(ctx, tx, slidesID, g.UserID)
	if err != nil {
		return "", time.Time{}, err
	}
	if RoleRank(role) < RoleRank(RoleView) {
		return "", time.Time{}, ErrNotFound
	}
	if RoleRank(role) < RoleRank(minRole) {
		return "", time.Time{}, ErrForbidden
	}
	return role, expires, nil
}

func loadSlidesSnapshotPG(ctx context.Context, tx pgx.Tx, slidesID int64) (SlidesVersionSnapshot, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, slides_id, pos, title, body, background, notes, shapes, hidden, layout, meta, revision, updated_at
		FROM slides_pages
		WHERE slides_id=$1
		ORDER BY pos, id`, slidesID)
	if err != nil {
		return SlidesVersionSnapshot{}, err
	}
	pages := make([]SlidesPage, 0)
	for rows.Next() {
		var pg SlidesPage
		if err = rows.Scan(
			&pg.ID, &pg.SlidesID, &pg.Pos, &pg.Title, &pg.Body, &pg.Background,
			&pg.Notes, &pg.Shapes, &pg.Hidden, &pg.Layout, &pg.Meta, &pg.Revision, &pg.UpdatedAt,
		); err != nil {
			rows.Close()
			return SlidesVersionSnapshot{}, err
		}
		shapes, ok := normalizeSlidesShapesJSON(pg.Shapes)
		if !ok {
			shapes = json.RawMessage(`[]`)
		}
		pg.Shapes = shapes
		pg.Meta = normalizeDBSlideMeta(pg.Meta)
		pages = append(pages, pg)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return SlidesVersionSnapshot{}, err
	}
	rows.Close()
	return SlidesVersionSnapshot{Pages: pages}, nil
}

func insertSlidesVersionPG(ctx context.Context, tx pgx.Tx, slidesID, userID int64, actorName, label string, autoSaved bool, snap SlidesVersionSnapshot) (SlidesVersionMeta, error) {
	if snap.Pages == nil {
		snap.Pages = []SlidesPage{}
	}
	rawSnap, err := json.Marshal(snap)
	if err != nil {
		return SlidesVersionMeta{}, err
	}
	var createdBy *int64
	if userID > 0 {
		uid := userID
		createdBy = &uid
	}
	meta := SlidesVersionMeta{
		SlidesID:  slidesID,
		Label:     label,
		AutoSaved: autoSaved,
		CreatedBy: userID,
		ActorName: actorName,
		PageCount: len(snap.Pages),
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO slides_versions (slides_id, label, auto_saved, snapshot, created_by, actor_name)
		VALUES ($1, $2, $3, $4::jsonb, $5, $6)
		RETURNING id, created_at`,
		slidesID, label, autoSaved, string(rawSnap), createdBy, actorName,
	).Scan(&meta.ID, &meta.CreatedAt)
	if err != nil {
		return SlidesVersionMeta{}, err
	}
	return meta, nil
}

func (p *Postgres) ListSlidesComments(ctx context.Context, guard RestoreGuard, slidesID int64) (out []SlidesComment, err error) {
	out = []SlidesComment{}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := authorizeSlidesExtrasPG(ctx, tx, guard, slidesID, RoleView, false)
		if e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `
			SELECT c.id, c.slides_id, c.page_id, c.shape_id, COALESCE(c.author_id, 0),
			       COALESCE(NULLIF(c.author_name, ''), (SELECT u.name FROM users u WHERE u.id = c.author_id), ''),
			       c.body, c.resolved, c.created_at, c.updated_at
			FROM slides_comments c
			WHERE c.slides_id = $1
			ORDER BY c.created_at ASC, c.id ASC`, slidesID)
		if e != nil {
			return e
		}
		list := []SlidesComment{}
		for rows.Next() {
			var cm SlidesComment
			if e = rows.Scan(
				&cm.ID, &cm.SlidesID, &cm.PageID, &cm.ShapeID, &cm.AuthorID,
				&cm.AuthorName, &cm.Body, &cm.Resolved, &cm.CreatedAt, &cm.UpdatedAt,
			); e != nil {
				rows.Close()
				return e
			}
			list = append(list, cm)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
		out = list
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) CreateSlidesCommentGuarded(ctx context.Context, guard RestoreGuard, slidesID, pageID int64, shapeID, body string) (out SlidesComment, err error) {
	cleanBody, ok := cleanSlidesCommentBody(body)
	if !ok {
		return out, ErrConflict
	}
	cleanShape, ok := cleanSlidesShapeID(shapeID)
	if !ok {
		return out, ErrConflict
	}
	if pageID <= 0 {
		return out, ErrNotFound
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := authorizeSlidesExtrasPG(ctx, tx, guard, slidesID, RoleView, false)
		if e != nil {
			return e
		}
		var pageExists int
		if e = tx.QueryRow(ctx, `SELECT 1 FROM slides_pages WHERE id=$1 AND slides_id=$2`, pageID, slidesID).Scan(&pageExists); e != nil {
			return notFound(e)
		}
		authorName, e := pgActorName(ctx, tx, guard.UserID)
		if e != nil {
			return e
		}
		var authorID *int64
		if guard.UserID > 0 {
			uid := guard.UserID
			authorID = &uid
		}
		e = tx.QueryRow(ctx, `
			INSERT INTO slides_comments (slides_id, page_id, shape_id, author_id, author_name, body, resolved)
			VALUES ($1, $2, $3, $4, $5, $6, false)
			RETURNING id, slides_id, page_id, shape_id, COALESCE(author_id, 0), author_name, body, resolved, created_at, updated_at`,
			slidesID, pageID, cleanShape, authorID, authorName, cleanBody,
		).Scan(
			&out.ID, &out.SlidesID, &out.PageID, &out.ShapeID, &out.AuthorID,
			&out.AuthorName, &out.Body, &out.Resolved, &out.CreatedAt, &out.UpdatedAt,
		)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) UpdateSlidesCommentGuarded(ctx context.Context, guard RestoreGuard, slidesID, commentID int64, body *string, resolved *bool) (out SlidesComment, err error) {
	if commentID <= 0 {
		return out, ErrNotFound
	}
	if body == nil && resolved == nil {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		role, expires, e := authorizeSlidesExtrasPG(ctx, tx, guard, slidesID, RoleView, false)
		if e != nil {
			return e
		}
		var curAuthorID int64
		var curBody string
		var curResolved bool
		e = tx.QueryRow(ctx, `
			SELECT COALESCE(author_id, 0), body, resolved
			FROM slides_comments
			WHERE id=$1 AND slides_id=$2
			FOR UPDATE`, commentID, slidesID).Scan(&curAuthorID, &curBody, &curResolved)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		nextBody := curBody
		if body != nil {
			if curAuthorID != guard.UserID && RoleRank(role) < RoleRank(RoleManage) {
				return ErrForbidden
			}
			cleanBody, ok := cleanSlidesCommentBody(*body)
			if !ok {
				return ErrConflict
			}
			nextBody = cleanBody
		}
		nextResolved := curResolved
		if resolved != nil {
			if curAuthorID != guard.UserID && RoleRank(role) < RoleRank(RoleEdit) {
				return ErrForbidden
			}
			nextResolved = *resolved
		}
		e = tx.QueryRow(ctx, `
			UPDATE slides_comments
			SET body=$2, resolved=$3, updated_at=now()
			WHERE id=$1 AND slides_id=$4
			RETURNING id, slides_id, page_id, shape_id, COALESCE(author_id, 0),
			          COALESCE(NULLIF(author_name, ''), (SELECT u.name FROM users u WHERE u.id = slides_comments.author_id), ''),
			          body, resolved, created_at, updated_at`,
			commentID, nextBody, nextResolved, slidesID,
		).Scan(
			&out.ID, &out.SlidesID, &out.PageID, &out.ShapeID, &out.AuthorID,
			&out.AuthorName, &out.Body, &out.Resolved, &out.CreatedAt, &out.UpdatedAt,
		)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) DeleteSlidesCommentGuarded(ctx context.Context, guard RestoreGuard, slidesID, commentID int64) error {
	if commentID <= 0 {
		return ErrNotFound
	}
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		role, expires, e := authorizeSlidesExtrasPG(ctx, tx, guard, slidesID, RoleView, false)
		if e != nil {
			return e
		}
		var authorID int64
		e = tx.QueryRow(ctx, `SELECT COALESCE(author_id, 0) FROM slides_comments WHERE id=$1 AND slides_id=$2 FOR UPDATE`, commentID, slidesID).Scan(&authorID)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if authorID != guard.UserID && RoleRank(role) < RoleRank(RoleManage) {
			return ErrForbidden
		}
		if _, e = tx.Exec(ctx, `DELETE FROM slides_comments WHERE id=$1 AND slides_id=$2`, commentID, slidesID); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return drivePGError(err)
}

func (p *Postgres) ListSlidesVersions(ctx context.Context, guard RestoreGuard, slidesID int64) (out []SlidesVersionMeta, err error) {
	out = []SlidesVersionMeta{}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := authorizeSlidesExtrasPG(ctx, tx, guard, slidesID, RoleView, false)
		if e != nil {
			return e
		}
		rows, e := tx.Query(ctx, `
			SELECT v.id, v.slides_id, v.label, v.auto_saved,
			       COALESCE(v.created_by, 0), v.actor_name, v.created_at,
			       CASE WHEN jsonb_typeof(v.snapshot->'pages') = 'array'
			            THEN jsonb_array_length(v.snapshot->'pages')
			            ELSE 0
			       END AS page_count
			FROM slides_versions v
			WHERE v.slides_id = $1
			ORDER BY v.created_at DESC, v.id DESC
			LIMIT $2`, slidesID, slidesVersionsMaxLimit)
		if e != nil {
			return e
		}
		list := []SlidesVersionMeta{}
		for rows.Next() {
			var m SlidesVersionMeta
			if e = rows.Scan(&m.ID, &m.SlidesID, &m.Label, &m.AutoSaved, &m.CreatedBy, &m.ActorName, &m.CreatedAt, &m.PageCount); e != nil {
				rows.Close()
				return e
			}
			list = append(list, m)
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			return e
		}
		rows.Close()
		out = list
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) CreateSlidesVersionGuarded(ctx context.Context, guard RestoreGuard, slidesID int64, label string, autoSaved bool) (out SlidesVersionMeta, err error) {
	cleanLabel, ok := normalizeSlidesVersionLabel(label, autoSaved)
	if !ok {
		return out, ErrConflict
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := authorizeSlidesExtrasPG(ctx, tx, guard, slidesID, RoleEdit, false)
		if e != nil {
			return e
		}
		snap, e := loadSlidesSnapshotPG(ctx, tx, slidesID)
		if e != nil {
			return e
		}
		actorName, e := pgActorName(ctx, tx, guard.UserID)
		if e != nil {
			return e
		}
		if e = drivePGEnd(ctx, guard, expires); e != nil {
			return e
		}
		out, e = insertSlidesVersionPG(ctx, tx, slidesID, guard.UserID, actorName, cleanLabel, autoSaved, snap)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, drivePGError(err)
}

func (p *Postgres) RestoreSlidesVersionGuarded(ctx context.Context, guard RestoreGuard, slidesID, versionID int64) (out []SlidesPage, err error) {
	if versionID <= 0 {
		return nil, ErrNotFound
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		_, expires, e := authorizeSlidesExtrasPG(ctx, tx, guard, slidesID, RoleEdit, true)
		if e != nil {
			return e
		}
		var rawTarget []byte
		e = tx.QueryRow(ctx, `SELECT snapshot FROM slides_versions WHERE id=$1 AND slides_id=$2`, versionID, slidesID).Scan(&rawTarget)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		var targetSnap SlidesVersionSnapshot
		if e = json.Unmarshal(rawTarget, &targetSnap); e != nil {
			return ErrConflict
		}
		restoredSrc, e := sanitizeRestoredSlidesPages(targetSnap)
		if e != nil {
			return e
		}
		currentSnap, e := loadSlidesSnapshotPG(ctx, tx, slidesID)
		if e != nil {
			return e
		}
		actorName, e := pgActorName(ctx, tx, guard.UserID)
		if e != nil {
			return e
		}
		if e = drivePGEnd(ctx, guard, expires); e != nil {
			return e
		}

		// Save automatic pre-restore backup inside the same transaction.
		if _, e = insertSlidesVersionPG(ctx, tx, slidesID, guard.UserID, actorName, slidesPreRestoreBackupLabel, true, currentSnap); e != nil {
			return e
		}

		if _, e = tx.Exec(ctx, `DELETE FROM slides_pages WHERE slides_id=$1`, slidesID); e != nil {
			return e
		}

		out = make([]SlidesPage, 0, len(restoredSrc))
		for i, src := range restoredSrc {
			var pg SlidesPage
			e = tx.QueryRow(ctx, `
				INSERT INTO slides_pages (slides_id, pos, title, body, background, notes, shapes, hidden, layout, meta, revision)
				VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, 1)
				RETURNING id, slides_id, pos, title, body, background, notes, shapes, hidden, layout, meta, revision, updated_at`,
				slidesID, float64(i+1), src.Title, src.Body, src.Background, src.Notes,
				string(src.Shapes), src.Hidden, src.Layout, slideMetaForPG(src.Meta),
			).Scan(
				&pg.ID, &pg.SlidesID, &pg.Pos, &pg.Title, &pg.Body, &pg.Background,
				&pg.Notes, &pg.Shapes, &pg.Hidden, &pg.Layout, &pg.Meta, &pg.Revision, &pg.UpdatedAt,
			)
			if e != nil {
				return e
			}
			pg.Meta = normalizeDBSlideMeta(pg.Meta)
			out = append(out, pg)
		}

		if _, e = tx.Exec(ctx, `UPDATE nodes SET updated_at=now() WHERE id=$1`, slidesID); e != nil {
			return e
		}
		if e = recordDocumentModifier(ctx, tx, slidesID, guard.UserID); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	if err != nil {
		return nil, drivePGError(err)
	}
	return out, nil
}
