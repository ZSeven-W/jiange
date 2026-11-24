package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	WebhookEventDocCreated           = "doc.created"
	WebhookEventDocDeleted           = "doc.deleted"
	WebhookEventShareUpdated         = "share.updated"
	WebhookEventBaseRecordMutated    = "base.record_mutated"
	WebhookEventSheetCellsUpdated    = "sheet.cells_updated"
	WebhookEventSlidesVersionCreated = "slides.version_created"
	WebhookEventTest                 = "webhook.test"

	MaxWebhooksPerWorkspace       = 25
	WebhookDeliveriesDefaultLimit = 30
	WebhookDeliveriesMaxLimit     = 100

	maxWebhookNameRunes         = 80
	maxWebhookURLLen            = 1024
	maxWebhookResponseBodyBytes = 1024
	maxWebhookErrorMsgBytes     = 512
	maxWebhookPayloadBytes      = 32768
)

// ErrWebhookLimitReached indicates a workspace already has the maximum number of webhooks.
var ErrWebhookLimitReached = fmt.Errorf("workspace webhook limit reached: %w", ErrConflict)

// ValidWebhookEvents lists every supported workspace event type for webhook subscriptions and deliveries.
var ValidWebhookEvents = []string{
	WebhookEventDocCreated,
	WebhookEventDocDeleted,
	WebhookEventShareUpdated,
	WebhookEventBaseRecordMutated,
	WebhookEventSheetCellsUpdated,
	WebhookEventSlidesVersionCreated,
	WebhookEventTest,
}

var validWebhookEventSet = func() map[string]struct{} {
	m := make(map[string]struct{}, len(ValidWebhookEvents))
	for _, ev := range ValidWebhookEvents {
		m[ev] = struct{}{}
	}
	return m
}()

// IsValidWebhookEvent reports whether eventType is in ValidWebhookEvents.
func IsValidWebhookEvent(eventType string) bool {
	_, ok := validWebhookEventSet[strings.ToLower(strings.TrimSpace(eventType))]
	return ok
}

// NormalizeWebhookEvents validates, deduplicates (preserving order), and trims webhook event names.
// Returns false if the list is empty or contains any unsupported event type.
func NormalizeWebhookEvents(events []string) ([]string, bool) {
	if len(events) == 0 {
		return nil, false
	}
	seen := make(map[string]struct{}, len(events))
	out := make([]string, 0, len(events))
	for _, raw := range events {
		ev := strings.ToLower(strings.TrimSpace(raw))
		if _, ok := validWebhookEventSet[ev]; !ok {
			return nil, false
		}
		if _, dup := seen[ev]; dup {
			continue
		}
		seen[ev] = struct{}{}
		out = append(out, ev)
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

// ValidWebhookURL validates an HTTP(S) webhook URL with a non-empty host, no credentials, and no fragment.
func ValidWebhookURL(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > maxWebhookURLLen {
		return "", false
	}
	u, err := url.Parse(trimmed)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", false
	}
	return u.String(), true
}

// WorkspaceWebhook configures an outbound workspace event webhook endpoint.
type WorkspaceWebhook struct {
	ID          int64     `json:"id"`
	WorkspaceID int64     `json:"workspaceId"`
	Name        string    `json:"name"`
	URL         string    `json:"url"`
	SecretEnc   []byte    `json:"-"`
	HasSecret   bool      `json:"hasSecret"`
	SecretHint  string    `json:"secretHint"`
	Events      []string  `json:"events"`
	Enabled     bool      `json:"enabled"`
	CreatedBy   *int64    `json:"createdBy,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// WorkspaceWebhookInput creates a new workspace event webhook.
type WorkspaceWebhookInput struct {
	Name       string
	URL        string
	SecretEnc  []byte
	SecretHint string
	Events     []string
	Enabled    bool
}

// WorkspaceWebhookPatch partially updates an existing workspace event webhook.
type WorkspaceWebhookPatch struct {
	Name         *string
	URL          *string
	SecretEnc    []byte
	SecretHint   string
	UpdateSecret bool
	Events       *[]string
	Enabled      *bool
}

// WebhookDelivery records a single outbound HTTP delivery attempt for a workspace webhook.
type WebhookDelivery struct {
	ID           int64           `json:"id"`
	WebhookID    int64           `json:"webhookId"`
	WorkspaceID  int64           `json:"workspaceId"`
	EventType    string          `json:"eventType"`
	Payload      json.RawMessage `json:"payload"`
	StatusCode   int             `json:"statusCode"`
	ResponseBody string          `json:"responseBody"`
	Attempt      int             `json:"attempt"`
	Success      bool            `json:"success"`
	ErrorMsg     string          `json:"errorMsg"`
	CreatedAt    time.Time       `json:"createdAt"`
}

// WebhookStore manages workspace event webhooks and their delivery audit history.
type WebhookStore interface {
	ListWorkspaceWebhooks(ctx context.Context, guard RestoreGuard, wsID int64) ([]WorkspaceWebhook, error)
	GetWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64) (WorkspaceWebhook, error)
	CreateWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID int64, in WorkspaceWebhookInput) (WorkspaceWebhook, error)
	UpdateWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64, patch WorkspaceWebhookPatch) (WorkspaceWebhook, error)
	DeleteWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64) error
	ListEnabledWebhooksForEvent(ctx context.Context, wsID int64, eventType string) ([]WorkspaceWebhook, error)
	RecordWebhookDelivery(ctx context.Context, d WebhookDelivery) (WebhookDelivery, error)
	ListWebhookDeliveriesGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64, limit int) ([]WebhookDelivery, error)
}

var (
	_ WebhookStore = (*Memory)(nil)
	_ WebhookStore = (*Postgres)(nil)
)

func validateWebhookFields(w *WorkspaceWebhook) error {
	w.Name = strings.TrimSpace(w.Name)
	if n := utf8.RuneCountInString(w.Name); n < 1 || n > maxWebhookNameRunes {
		return ErrConflict
	}
	u, ok := ValidWebhookURL(w.URL)
	if !ok {
		return ErrConflict
	}
	w.URL = u
	events, ok := NormalizeWebhookEvents(w.Events)
	if !ok {
		return ErrConflict
	}
	w.Events = events
	w.SecretHint = strings.TrimSpace(w.SecretHint)
	if len(w.SecretHint) > 32 {
		w.SecretHint = w.SecretHint[:32]
	}
	w.HasSecret = len(w.SecretEnc) > 0
	return nil
}

func cloneWorkspaceWebhook(w WorkspaceWebhook, includeSecret bool) WorkspaceWebhook {
	w.HasSecret = len(w.SecretEnc) > 0
	if includeSecret && len(w.SecretEnc) > 0 {
		cp := make([]byte, len(w.SecretEnc))
		copy(cp, w.SecretEnc)
		w.SecretEnc = cp
	} else {
		w.SecretEnc = nil
	}
	if w.Events != nil {
		ev := make([]string, len(w.Events))
		copy(ev, w.Events)
		w.Events = ev
	} else {
		w.Events = []string{}
	}
	if w.CreatedBy != nil {
		v := *w.CreatedBy
		w.CreatedBy = &v
	}
	return w
}

func truncateUTF8Bytes(s string, maxBytes int) string {
	if maxBytes <= 0 || len(s) <= maxBytes {
		return s
	}
	out := s[:maxBytes]
	for len(out) > 0 && !utf8.ValidString(out) {
		out = out[:len(out)-1]
	}
	return out
}

func normalizeWebhookPayload(raw json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return json.RawMessage("{}")
	}
	if len(trimmed) > maxWebhookPayloadBytes {
		return json.RawMessage(`{"truncated":true}`)
	}
	cp := make([]byte, len(trimmed))
	copy(cp, trimmed)
	return json.RawMessage(cp)
}

func sanitizeWebhookDelivery(d WebhookDelivery) (WebhookDelivery, error) {
	if d.WebhookID <= 0 || d.WorkspaceID <= 0 {
		return WebhookDelivery{}, ErrConflict
	}
	d.EventType = strings.ToLower(strings.TrimSpace(d.EventType))
	if d.EventType == "" || len(d.EventType) > 100 {
		return WebhookDelivery{}, ErrConflict
	}
	d.Payload = normalizeWebhookPayload(d.Payload)
	if d.StatusCode < 0 {
		d.StatusCode = 0
	}
	d.ResponseBody = truncateUTF8Bytes(strings.ToValidUTF8(d.ResponseBody, ""), maxWebhookResponseBodyBytes)
	d.ErrorMsg = truncateUTF8Bytes(strings.ToValidUTF8(strings.TrimSpace(d.ErrorMsg), ""), maxWebhookErrorMsgBytes)
	if d.Attempt < 1 {
		d.Attempt = 1
	}
	if d.CreatedAt.IsZero() {
		d.CreatedAt = time.Now().UTC()
	} else {
		d.CreatedAt = d.CreatedAt.UTC()
	}
	return d, nil
}

func cloneWebhookDelivery(d WebhookDelivery) WebhookDelivery {
	d.Payload = normalizeWebhookPayload(d.Payload)
	return d
}

func normalizeWebhookDeliveryLimit(limit int) int {
	if limit <= 0 {
		return WebhookDeliveriesDefaultLimit
	}
	if limit > WebhookDeliveriesMaxLimit {
		return WebhookDeliveriesMaxLimit
	}
	return limit
}

func webhookContainsEvent(events []string, target string) bool {
	for _, ev := range events {
		if ev == target {
			return true
		}
	}
	return false
}

// --- Memory implementation ---

// memWebhooks holds in-memory workspace event webhooks and delivery logs for Memory store.
type memWebhooks struct {
	nextWebhookID  int64
	nextDeliveryID int64
	items          map[int64]WorkspaceWebhook
	deliveries     []WebhookDelivery
}

func (m *Memory) initWebhooksLocked() {
	if m.webhooks.items == nil {
		m.webhooks.items = map[int64]WorkspaceWebhook{}
	}
}

func (m *Memory) ListWorkspaceWebhooks(ctx context.Context, guard RestoreGuard, wsID int64) ([]WorkspaceWebhook, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return nil, err
	}
	out := make([]WorkspaceWebhook, 0)
	for _, w := range m.webhooks.items {
		if w.WorkspaceID == wsID {
			out = append(out, cloneWorkspaceWebhook(w, false))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	return out, nil
}

func (m *Memory) GetWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64) (WorkspaceWebhook, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return WorkspaceWebhook{}, err
	}
	w, ok := m.webhooks.items[webhookID]
	if !ok || w.WorkspaceID != wsID {
		return WorkspaceWebhook{}, ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WorkspaceWebhook{}, err
	}
	return cloneWorkspaceWebhook(w, true), nil
}

func (m *Memory) CreateWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID int64, in WorkspaceWebhookInput) (WorkspaceWebhook, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return WorkspaceWebhook{}, err
	}
	m.initWebhooksLocked()

	now := guard.currentTime()
	createdBy := guard.UserID
	w := WorkspaceWebhook{
		WorkspaceID: wsID,
		Name:        in.Name,
		URL:         in.URL,
		SecretEnc:   append([]byte(nil), in.SecretEnc...),
		SecretHint:  in.SecretHint,
		Events:      append([]string(nil), in.Events...),
		Enabled:     in.Enabled,
		CreatedBy:   &createdBy,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := validateWebhookFields(&w); err != nil {
		return WorkspaceWebhook{}, err
	}
	count := 0
	for _, existing := range m.webhooks.items {
		if existing.WorkspaceID == wsID {
			count++
		}
	}
	if count >= MaxWebhooksPerWorkspace {
		return WorkspaceWebhook{}, ErrWebhookLimitReached
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WorkspaceWebhook{}, err
	}
	m.webhooks.nextWebhookID++
	w.ID = m.webhooks.nextWebhookID
	m.webhooks.items[w.ID] = w
	return cloneWorkspaceWebhook(w, false), nil
}

func (m *Memory) UpdateWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64, patch WorkspaceWebhookPatch) (WorkspaceWebhook, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return WorkspaceWebhook{}, err
	}
	cur, ok := m.webhooks.items[webhookID]
	if !ok || cur.WorkspaceID != wsID {
		return WorkspaceWebhook{}, ErrNotFound
	}
	next := cloneWorkspaceWebhook(cur, true)
	if patch.Name != nil {
		next.Name = *patch.Name
	}
	if patch.URL != nil {
		next.URL = *patch.URL
	}
	if patch.UpdateSecret {
		next.SecretEnc = append([]byte(nil), patch.SecretEnc...)
		next.SecretHint = patch.SecretHint
	}
	if patch.Events != nil {
		next.Events = append([]string(nil), (*patch.Events)...)
	}
	if patch.Enabled != nil {
		next.Enabled = *patch.Enabled
	}
	next.UpdatedAt = guard.currentTime()
	if err := validateWebhookFields(&next); err != nil {
		return WorkspaceWebhook{}, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return WorkspaceWebhook{}, err
	}
	m.webhooks.items[webhookID] = next
	return cloneWorkspaceWebhook(next, false), nil
}

func (m *Memory) DeleteWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return err
	}
	cur, ok := m.webhooks.items[webhookID]
	if !ok || cur.WorkspaceID != wsID {
		return ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	delete(m.webhooks.items, webhookID)
	if len(m.webhooks.deliveries) > 0 {
		kept := m.webhooks.deliveries[:0]
		for _, d := range m.webhooks.deliveries {
			if d.WebhookID != webhookID {
				kept = append(kept, d)
			}
		}
		m.webhooks.deliveries = kept
	}
	return nil
}

func (m *Memory) ListEnabledWebhooksForEvent(ctx context.Context, wsID int64, eventType string) ([]WorkspaceWebhook, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	target := strings.ToLower(strings.TrimSpace(eventType))
	out := make([]WorkspaceWebhook, 0)
	if target == "" {
		return out, nil
	}
	for _, w := range m.webhooks.items {
		if w.WorkspaceID == wsID && w.Enabled && webhookContainsEvent(w.Events, target) {
			out = append(out, cloneWorkspaceWebhook(w, true))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) RecordWebhookDelivery(ctx context.Context, d WebhookDelivery) (WebhookDelivery, error) {
	if err := ctx.Err(); err != nil {
		return WebhookDelivery{}, err
	}
	clean, err := sanitizeWebhookDelivery(d)
	if err != nil {
		return WebhookDelivery{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	wh, ok := m.webhooks.items[clean.WebhookID]
	if !ok || wh.WorkspaceID != clean.WorkspaceID {
		return WebhookDelivery{}, ErrNotFound
	}
	m.webhooks.nextDeliveryID++
	clean.ID = m.webhooks.nextDeliveryID
	m.webhooks.deliveries = append(m.webhooks.deliveries, clean)
	return cloneWebhookDelivery(clean), nil
}

func (m *Memory) ListWebhookDeliveriesGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64, limit int) ([]WebhookDelivery, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return nil, err
	}
	wh, ok := m.webhooks.items[webhookID]
	if !ok || wh.WorkspaceID != wsID {
		return nil, ErrNotFound
	}
	lim := normalizeWebhookDeliveryLimit(limit)
	matched := make([]WebhookDelivery, 0)
	for _, d := range m.webhooks.deliveries {
		if d.WebhookID == webhookID && d.WorkspaceID == wsID {
			matched = append(matched, cloneWebhookDelivery(d))
		}
	}
	sort.Slice(matched, func(i, j int) bool {
		if !matched[i].CreatedAt.Equal(matched[j].CreatedAt) {
			return matched[i].CreatedAt.After(matched[j].CreatedAt)
		}
		return matched[i].ID > matched[j].ID
	})
	if len(matched) > lim {
		matched = matched[:lim]
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	return matched, nil
}

// --- Postgres implementation ---

const webhookSelectCols = `id, workspace_id, name, url, secret_enc, secret_hint, events, enabled, created_by, created_at, updated_at`

func webhookPGError(err error) error {
	var pgErr *pgconn.PgError
	if retryableRestoreConflict(err) || (errors.As(err, &pgErr) && (pgErr.Code == "23514" || pgErr.Code == "23505" || pgErr.Code == "23503")) {
		return ErrConflict
	}
	return err
}

func scanWorkspaceWebhook(r pgx.Row, includeSecret bool) (WorkspaceWebhook, error) {
	var w WorkspaceWebhook
	var secretEnc []byte
	var eventsJSON []byte
	err := r.Scan(
		&w.ID, &w.WorkspaceID, &w.Name, &w.URL,
		&secretEnc, &w.SecretHint, &eventsJSON, &w.Enabled,
		&w.CreatedBy, &w.CreatedAt, &w.UpdatedAt,
	)
	if err != nil {
		return WorkspaceWebhook{}, err
	}
	w.HasSecret = len(secretEnc) > 0
	if includeSecret && len(secretEnc) > 0 {
		w.SecretEnc = secretEnc
	}
	var events []string
	if len(eventsJSON) > 0 {
		_ = json.Unmarshal(eventsJSON, &events)
	}
	if events == nil {
		events = []string{}
	}
	w.Events = events
	return w, nil
}

func (p *Postgres) ListWorkspaceWebhooks(ctx context.Context, guard RestoreGuard, wsID int64) (out []WorkspaceWebhook, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		rows, e := tx.Query(ctx,
			`SELECT `+webhookSelectCols+`
			   FROM workspace_webhooks
			  WHERE workspace_id = $1
			  ORDER BY id ASC`, wsID)
		if e != nil {
			return e
		}
		defer rows.Close()
		out = make([]WorkspaceWebhook, 0)
		for rows.Next() {
			item, e := scanWorkspaceWebhook(rows, false)
			if e != nil {
				return e
			}
			out = append(out, item)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, webhookPGError(err)
}

func (p *Postgres) GetWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64) (out WorkspaceWebhook, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		out, e = scanWorkspaceWebhook(tx.QueryRow(ctx,
			`SELECT `+webhookSelectCols+`
			   FROM workspace_webhooks
			  WHERE id = $1 AND workspace_id = $2`, webhookID, wsID), true)
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, webhookPGError(err)
}

func (p *Postgres) CreateWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID int64, in WorkspaceWebhookInput) (out WorkspaceWebhook, err error) {
	cand := WorkspaceWebhook{
		WorkspaceID: wsID,
		Name:        in.Name,
		URL:         in.URL,
		SecretEnc:   in.SecretEnc,
		SecretHint:  in.SecretHint,
		Events:      in.Events,
		Enabled:     in.Enabled,
	}
	if err := validateWebhookFields(&cand); err != nil {
		return WorkspaceWebhook{}, err
	}
	eventsJSON, err := json.Marshal(cand.Events)
	if err != nil {
		return WorkspaceWebhook{}, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		// Lock workspace row so concurrent webhook creations enforce MaxWebhooksPerWorkspace atomically.
		var lockedID int64
		if e = tx.QueryRow(ctx, `SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, wsID).Scan(&lockedID); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		var count int
		if e = tx.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_webhooks WHERE workspace_id = $1`, wsID).Scan(&count); e != nil {
			return e
		}
		if count >= MaxWebhooksPerWorkspace {
			return ErrWebhookLimitReached
		}
		row := tx.QueryRow(ctx,
			`INSERT INTO workspace_webhooks (
				workspace_id, name, url, secret_enc, secret_hint, events, enabled, created_by
			) VALUES (
				$1, $2, $3, $4, $5, $6::jsonb, $7, $8
			) RETURNING `+webhookSelectCols,
			wsID, cand.Name, cand.URL, cand.SecretEnc, cand.SecretHint, string(eventsJSON), cand.Enabled, guard.UserID,
		)
		out, e = scanWorkspaceWebhook(row, false)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, webhookPGError(err)
}

func (p *Postgres) UpdateWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64, patch WorkspaceWebhookPatch) (out WorkspaceWebhook, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		cur, e := scanWorkspaceWebhook(tx.QueryRow(ctx,
			`SELECT `+webhookSelectCols+`
			   FROM workspace_webhooks
			  WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
			webhookID, wsID), true)
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		if patch.Name != nil {
			cur.Name = *patch.Name
		}
		if patch.URL != nil {
			cur.URL = *patch.URL
		}
		if patch.UpdateSecret {
			cur.SecretEnc = patch.SecretEnc
			cur.SecretHint = patch.SecretHint
		}
		if patch.Events != nil {
			cur.Events = append([]string(nil), (*patch.Events)...)
		}
		if patch.Enabled != nil {
			cur.Enabled = *patch.Enabled
		}
		if e = validateWebhookFields(&cur); e != nil {
			return e
		}
		eventsJSON, e := json.Marshal(cur.Events)
		if e != nil {
			return e
		}
		out, e = scanWorkspaceWebhook(tx.QueryRow(ctx,
			`UPDATE workspace_webhooks
			    SET name = $3, url = $4, secret_enc = $5, secret_hint = $6,
			        events = $7::jsonb, enabled = $8, updated_at = now()
			  WHERE id = $1 AND workspace_id = $2
			  RETURNING `+webhookSelectCols,
			webhookID, wsID,
			cur.Name, cur.URL, cur.SecretEnc, cur.SecretHint,
			string(eventsJSON), cur.Enabled,
		), false)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, webhookPGError(err)
}

func (p *Postgres) DeleteWorkspaceWebhookGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `DELETE FROM workspace_webhooks WHERE id = $1 AND workspace_id = $2`, webhookID, wsID)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return webhookPGError(err)
}

func (p *Postgres) ListEnabledWebhooksForEvent(ctx context.Context, wsID int64, eventType string) ([]WorkspaceWebhook, error) {
	target := strings.ToLower(strings.TrimSpace(eventType))
	if target == "" {
		return []WorkspaceWebhook{}, nil
	}
	rows, err := p.Pool.Query(ctx,
		`SELECT `+webhookSelectCols+`
		   FROM workspace_webhooks
		  WHERE workspace_id = $1
		    AND enabled = true
		    AND events @> jsonb_build_array($2::text)
		  ORDER BY id ASC`, wsID, target)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]WorkspaceWebhook, 0)
	for rows.Next() {
		item, err := scanWorkspaceWebhook(rows, true)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (p *Postgres) RecordWebhookDelivery(ctx context.Context, d WebhookDelivery) (WebhookDelivery, error) {
	clean, err := sanitizeWebhookDelivery(d)
	if err != nil {
		return WebhookDelivery{}, err
	}
	var out WebhookDelivery
	var payloadBytes []byte
	err = p.Pool.QueryRow(ctx,
		`INSERT INTO webhook_deliveries (
			webhook_id, workspace_id, event_type, payload, status_code,
			response_body, attempt, success, error_msg, created_at
		) VALUES (
			$1, $2, $3, $4::jsonb, $5,
			$6, $7, $8, $9, $10
		) RETURNING id, webhook_id, workspace_id, event_type, payload,
		            status_code, response_body, attempt, success, error_msg, created_at`,
		clean.WebhookID, clean.WorkspaceID, clean.EventType, string(clean.Payload), clean.StatusCode,
		clean.ResponseBody, clean.Attempt, clean.Success, clean.ErrorMsg, clean.CreatedAt,
	).Scan(
		&out.ID, &out.WebhookID, &out.WorkspaceID, &out.EventType, &payloadBytes,
		&out.StatusCode, &out.ResponseBody, &out.Attempt, &out.Success, &out.ErrorMsg, &out.CreatedAt,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return WebhookDelivery{}, ErrNotFound
		}
		return WebhookDelivery{}, webhookPGError(err)
	}
	out.Payload = normalizeWebhookPayload(payloadBytes)
	return out, nil
}

func (p *Postgres) ListWebhookDeliveriesGuarded(ctx context.Context, guard RestoreGuard, wsID, webhookID int64, limit int) (out []WebhookDelivery, err error) {
	lim := normalizeWebhookDeliveryLimit(limit)
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		var exists int64
		if e = tx.QueryRow(ctx,
			`SELECT id FROM workspace_webhooks WHERE id = $1 AND workspace_id = $2`,
			webhookID, wsID,
		).Scan(&exists); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		rows, e := tx.Query(ctx,
			`SELECT id, webhook_id, workspace_id, event_type, payload,
			        status_code, response_body, attempt, success, error_msg, created_at
			   FROM webhook_deliveries
			  WHERE webhook_id = $1 AND workspace_id = $2
			  ORDER BY created_at DESC, id DESC
			  LIMIT $3`, webhookID, wsID, lim)
		if e != nil {
			return e
		}
		defer rows.Close()
		out = make([]WebhookDelivery, 0)
		for rows.Next() {
			var item WebhookDelivery
			var payloadBytes []byte
			if e = rows.Scan(
				&item.ID, &item.WebhookID, &item.WorkspaceID, &item.EventType, &payloadBytes,
				&item.StatusCode, &item.ResponseBody, &item.Attempt, &item.Success, &item.ErrorMsg, &item.CreatedAt,
			); e != nil {
				return e
			}
			item.Payload = normalizeWebhookPayload(payloadBytes)
			out = append(out, item)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, webhookPGError(err)
}
