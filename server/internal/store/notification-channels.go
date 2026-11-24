package store

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	NotificationChannelKindSMTP        = "smtp"
	NotificationChannelKindFeishuBot   = "feishu_bot"
	NotificationChannelKindDingTalkBot = "dingtalk_bot"
	NotificationChannelKindWeComBot    = "wecom_bot"
	NotificationChannelKindSlackBot    = "slack_bot"

	NotificationEventMention      = "mention"
	NotificationEventCommentReply = "comment_reply"
	NotificationEventAutomation   = "automation"
	NotificationEventShareUpdated = "share_updated"

	MaxNotificationChannelsPerWorkspace = 20

	maxNotificationChannelNameRunes   = 100
	maxNotificationChannelHintRunes   = 256
	maxNotificationChannelStatusRunes = 32
	maxNotificationChannelErrorBytes  = 512
)

// ErrNotificationChannelLimitReached indicates a workspace already has the maximum number of external notification channels.
var ErrNotificationChannelLimitReached = fmt.Errorf("workspace notification channel limit reached: %w", ErrConflict)

// ValidNotificationChannelKinds lists every supported outbound notification channel kind.
var ValidNotificationChannelKinds = []string{
	NotificationChannelKindSMTP,
	NotificationChannelKindFeishuBot,
	NotificationChannelKindDingTalkBot,
	NotificationChannelKindWeComBot,
	NotificationChannelKindSlackBot,
}

var validNotificationChannelKindSet = func() map[string]struct{} {
	m := make(map[string]struct{}, len(ValidNotificationChannelKinds))
	for _, k := range ValidNotificationChannelKinds {
		m[k] = struct{}{}
	}
	return m
}()

// ValidNotificationEvents lists every workspace event type subscribable by external notification channels.
var ValidNotificationEvents = []string{
	NotificationEventMention,
	NotificationEventCommentReply,
	NotificationEventAutomation,
	NotificationEventShareUpdated,
}

var validNotificationEventSet = func() map[string]struct{} {
	m := make(map[string]struct{}, len(ValidNotificationEvents))
	for _, ev := range ValidNotificationEvents {
		m[ev] = struct{}{}
	}
	return m
}()

// IsValidNotificationChannelKind reports whether kind is in ValidNotificationChannelKinds.
func IsValidNotificationChannelKind(kind string) bool {
	_, ok := validNotificationChannelKindSet[strings.ToLower(strings.TrimSpace(kind))]
	return ok
}

// IsValidNotificationEvent reports whether event is in ValidNotificationEvents.
func IsValidNotificationEvent(event string) bool {
	_, ok := validNotificationEventSet[strings.ToLower(strings.TrimSpace(event))]
	return ok
}

// NormalizeNotificationEvents validates, trims, lowercases, and deduplicates channel event names.
// Returns false if the list is empty or contains an unsupported event name.
func NormalizeNotificationEvents(events []string) ([]string, bool) {
	if len(events) == 0 {
		return nil, false
	}
	seen := make(map[string]struct{}, len(events))
	out := make([]string, 0, len(events))
	for _, raw := range events {
		ev := strings.ToLower(strings.TrimSpace(raw))
		if _, ok := validNotificationEventSet[ev]; !ok {
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

// NotificationChannel configures an outbound workspace notification destination
// (SMTP email or Feishu / DingTalk / WeCom / Slack incoming bot webhook).
type NotificationChannel struct {
	ID          int64      `json:"id"`
	WorkspaceID int64      `json:"workspaceId"`
	Name        string     `json:"name"`
	Kind        string     `json:"kind"`
	ConfigEnc   []byte     `json:"-"`
	ConfigHint  string     `json:"configHint"`
	Events      []string   `json:"events"`
	Enabled     bool       `json:"enabled"`
	LastStatus  string     `json:"lastStatus"`
	LastError   string     `json:"lastError"`
	LastSentAt  *time.Time `json:"lastSentAt,omitempty"`
	CreatedBy   *int64     `json:"createdBy,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

// NotificationChannelInput creates a new workspace external notification channel.
type NotificationChannelInput struct {
	Name       string
	Kind       string
	ConfigEnc  []byte
	ConfigHint string
	Events     []string
	Enabled    bool
}

// NotificationChannelPatch partially updates an existing notification channel.
type NotificationChannelPatch struct {
	Name         *string
	Kind         *string
	ConfigEnc    []byte
	ConfigHint   string
	UpdateConfig bool
	Events       *[]string
	Enabled      *bool
}

// NotificationChannelStore manages workspace external notification channels.
type NotificationChannelStore interface {
	ListNotificationChannels(ctx context.Context, guard RestoreGuard, wsID int64) ([]NotificationChannel, error)
	GetNotificationChannel(ctx context.Context, guard RestoreGuard, wsID, channelID int64) (NotificationChannel, error)
	CreateNotificationChannel(ctx context.Context, guard RestoreGuard, wsID int64, in NotificationChannelInput) (NotificationChannel, error)
	UpdateNotificationChannel(ctx context.Context, guard RestoreGuard, wsID, channelID int64, patch NotificationChannelPatch) (NotificationChannel, error)
	DeleteNotificationChannel(ctx context.Context, guard RestoreGuard, wsID, channelID int64) error
	ListActiveNotificationChannelsForEvent(ctx context.Context, wsID int64, event string) ([]NotificationChannel, error)
	RecordNotificationChannelDelivery(ctx context.Context, wsID, channelID int64, status, errMsg string, sentAt time.Time) error
}

var (
	_ NotificationChannelStore = (*Memory)(nil)
	_ NotificationChannelStore = (*Postgres)(nil)
)

func clampNotificationRunes(s string, maxRunes int) string {
	trimmed := strings.TrimSpace(strings.ToValidUTF8(s, ""))
	if maxRunes <= 0 || utf8.RuneCountInString(trimmed) <= maxRunes {
		return trimmed
	}
	var b strings.Builder
	b.Grow(len(trimmed))
	n := 0
	for _, r := range trimmed {
		if n >= maxRunes {
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

func validateNotificationChannelFields(ch *NotificationChannel) error {
	ch.Name = strings.TrimSpace(ch.Name)
	if n := utf8.RuneCountInString(ch.Name); n < 1 || n > maxNotificationChannelNameRunes {
		return ErrConflict
	}
	ch.Kind = strings.ToLower(strings.TrimSpace(ch.Kind))
	if !IsValidNotificationChannelKind(ch.Kind) {
		return ErrConflict
	}
	if len(ch.ConfigEnc) == 0 {
		return ErrConflict
	}
	ch.ConfigHint = clampNotificationRunes(ch.ConfigHint, maxNotificationChannelHintRunes)
	events, ok := NormalizeNotificationEvents(ch.Events)
	if !ok {
		return ErrConflict
	}
	ch.Events = events
	return nil
}

func cloneNotificationChannel(ch NotificationChannel, includeConfig bool) NotificationChannel {
	if includeConfig && len(ch.ConfigEnc) > 0 {
		cp := make([]byte, len(ch.ConfigEnc))
		copy(cp, ch.ConfigEnc)
		ch.ConfigEnc = cp
	} else {
		ch.ConfigEnc = nil
	}
	if ch.Events != nil {
		ev := make([]string, len(ch.Events))
		copy(ev, ch.Events)
		ch.Events = ev
	} else {
		ch.Events = []string{}
	}
	if ch.LastSentAt != nil {
		t := ch.LastSentAt.UTC()
		ch.LastSentAt = &t
	}
	if ch.CreatedBy != nil {
		v := *ch.CreatedBy
		ch.CreatedBy = &v
	}
	return ch
}

func notifChannelContainsEvent(events []string, target string) bool {
	for _, ev := range events {
		if ev == target {
			return true
		}
	}
	return false
}

// --- Memory implementation ---

type memNotifChannels struct {
	nextID int64
	items  map[int64]NotificationChannel
}

func (m *Memory) initNotifChannelsLocked() {
	if m.notifChannels.items == nil {
		m.notifChannels.items = map[int64]NotificationChannel{}
	}
}

func (m *Memory) ListNotificationChannels(ctx context.Context, guard RestoreGuard, wsID int64) ([]NotificationChannel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return nil, err
	}
	out := make([]NotificationChannel, 0)
	for _, ch := range m.notifChannels.items {
		if ch.WorkspaceID == wsID {
			out = append(out, cloneNotificationChannel(ch, false))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	return out, nil
}

func (m *Memory) GetNotificationChannel(ctx context.Context, guard RestoreGuard, wsID, channelID int64) (NotificationChannel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return NotificationChannel{}, err
	}
	ch, ok := m.notifChannels.items[channelID]
	if !ok || ch.WorkspaceID != wsID {
		return NotificationChannel{}, ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return NotificationChannel{}, err
	}
	return cloneNotificationChannel(ch, true), nil
}

func (m *Memory) CreateNotificationChannel(ctx context.Context, guard RestoreGuard, wsID int64, in NotificationChannelInput) (NotificationChannel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return NotificationChannel{}, err
	}
	m.initNotifChannelsLocked()

	now := guard.currentTime().UTC()
	createdBy := guard.UserID
	ch := NotificationChannel{
		WorkspaceID: wsID,
		Name:        in.Name,
		Kind:        in.Kind,
		ConfigEnc:   append([]byte(nil), in.ConfigEnc...),
		ConfigHint:  in.ConfigHint,
		Events:      append([]string(nil), in.Events...),
		Enabled:     in.Enabled,
		CreatedBy:   &createdBy,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := validateNotificationChannelFields(&ch); err != nil {
		return NotificationChannel{}, err
	}
	count := 0
	for _, existing := range m.notifChannels.items {
		if existing.WorkspaceID == wsID {
			count++
		}
	}
	if count >= MaxNotificationChannelsPerWorkspace {
		return NotificationChannel{}, ErrNotificationChannelLimitReached
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return NotificationChannel{}, err
	}
	m.notifChannels.nextID++
	ch.ID = m.notifChannels.nextID
	m.notifChannels.items[ch.ID] = ch
	return cloneNotificationChannel(ch, false), nil
}

func (m *Memory) UpdateNotificationChannel(ctx context.Context, guard RestoreGuard, wsID, channelID int64, patch NotificationChannelPatch) (NotificationChannel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return NotificationChannel{}, err
	}
	cur, ok := m.notifChannels.items[channelID]
	if !ok || cur.WorkspaceID != wsID {
		return NotificationChannel{}, ErrNotFound
	}
	next := cloneNotificationChannel(cur, true)
	if patch.Name != nil {
		next.Name = *patch.Name
	}
	if patch.Kind != nil {
		next.Kind = *patch.Kind
	}
	if patch.UpdateConfig {
		next.ConfigEnc = append([]byte(nil), patch.ConfigEnc...)
		next.ConfigHint = patch.ConfigHint
	}
	if patch.Events != nil {
		next.Events = append([]string(nil), (*patch.Events)...)
	}
	if patch.Enabled != nil {
		next.Enabled = *patch.Enabled
	}
	next.UpdatedAt = guard.currentTime().UTC()
	if err := validateNotificationChannelFields(&next); err != nil {
		return NotificationChannel{}, err
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return NotificationChannel{}, err
	}
	m.notifChannels.items[channelID] = next
	return cloneNotificationChannel(next, false), nil
}

func (m *Memory) DeleteNotificationChannel(ctx context.Context, guard RestoreGuard, wsID, channelID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return err
	}
	cur, ok := m.notifChannels.items[channelID]
	if !ok || cur.WorkspaceID != wsID {
		return ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	delete(m.notifChannels.items, channelID)
	return nil
}

func (m *Memory) ListActiveNotificationChannelsForEvent(ctx context.Context, wsID int64, event string) ([]NotificationChannel, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	target := strings.ToLower(strings.TrimSpace(event))
	out := make([]NotificationChannel, 0)
	if target == "" {
		return out, nil
	}
	for _, ch := range m.notifChannels.items {
		if ch.WorkspaceID == wsID && ch.Enabled && notifChannelContainsEvent(ch.Events, target) {
			out = append(out, cloneNotificationChannel(ch, true))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) RecordNotificationChannelDelivery(ctx context.Context, wsID, channelID int64, status, errMsg string, sentAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	ch, ok := m.notifChannels.items[channelID]
	if !ok || ch.WorkspaceID != wsID {
		return ErrNotFound
	}
	if sentAt.IsZero() {
		sentAt = time.Now().UTC()
	} else {
		sentAt = sentAt.UTC()
	}
	ch.LastStatus = clampNotificationRunes(status, maxNotificationChannelStatusRunes)
	ch.LastError = truncateUTF8Bytes(strings.ToValidUTF8(strings.TrimSpace(errMsg), ""), maxNotificationChannelErrorBytes)
	ch.LastSentAt = &sentAt
	m.notifChannels.items[channelID] = ch
	return nil
}

// --- Postgres implementation ---

const notifChannelSelectCols = `id, workspace_id, name, kind, config_enc, config_hint, events, enabled, last_status, last_error, last_sent_at, created_by, created_at, updated_at`

func notifChannelPGError(err error) error {
	var pgErr *pgconn.PgError
	if retryableRestoreConflict(err) || (errors.As(err, &pgErr) && (pgErr.Code == "23514" || pgErr.Code == "23505" || pgErr.Code == "23503")) {
		return ErrConflict
	}
	return err
}

func scanNotificationChannel(r pgx.Row, includeConfig bool) (NotificationChannel, error) {
	var ch NotificationChannel
	var configEnc []byte
	var events []string
	err := r.Scan(
		&ch.ID, &ch.WorkspaceID, &ch.Name, &ch.Kind,
		&configEnc, &ch.ConfigHint, &events, &ch.Enabled,
		&ch.LastStatus, &ch.LastError, &ch.LastSentAt,
		&ch.CreatedBy, &ch.CreatedAt, &ch.UpdatedAt,
	)
	if err != nil {
		return NotificationChannel{}, err
	}
	if includeConfig && len(configEnc) > 0 {
		ch.ConfigEnc = configEnc
	}
	if events == nil {
		events = []string{}
	}
	ch.Events = events
	return ch, nil
}

func (p *Postgres) ListNotificationChannels(ctx context.Context, guard RestoreGuard, wsID int64) (out []NotificationChannel, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		rows, e := tx.Query(ctx,
			`SELECT `+notifChannelSelectCols+`
			   FROM workspace_notification_channels
			  WHERE workspace_id = $1
			  ORDER BY created_at DESC, id DESC`, wsID)
		if e != nil {
			return e
		}
		defer rows.Close()
		out = make([]NotificationChannel, 0)
		for rows.Next() {
			item, e := scanNotificationChannel(rows, false)
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
	return out, notifChannelPGError(err)
}

func (p *Postgres) GetNotificationChannel(ctx context.Context, guard RestoreGuard, wsID, channelID int64) (out NotificationChannel, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		out, e = scanNotificationChannel(tx.QueryRow(ctx,
			`SELECT `+notifChannelSelectCols+`
			   FROM workspace_notification_channels
			  WHERE id = $1 AND workspace_id = $2`, channelID, wsID), true)
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, notifChannelPGError(err)
}

func (p *Postgres) CreateNotificationChannel(ctx context.Context, guard RestoreGuard, wsID int64, in NotificationChannelInput) (out NotificationChannel, err error) {
	cand := NotificationChannel{
		WorkspaceID: wsID,
		Name:        in.Name,
		Kind:        in.Kind,
		ConfigEnc:   in.ConfigEnc,
		ConfigHint:  in.ConfigHint,
		Events:      in.Events,
		Enabled:     in.Enabled,
	}
	if err := validateNotificationChannelFields(&cand); err != nil {
		return NotificationChannel{}, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		var lockedID int64
		if e = tx.QueryRow(ctx, `SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, wsID).Scan(&lockedID); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		var count int
		if e = tx.QueryRow(ctx, `SELECT COUNT(*) FROM workspace_notification_channels WHERE workspace_id = $1`, wsID).Scan(&count); e != nil {
			return e
		}
		if count >= MaxNotificationChannelsPerWorkspace {
			return ErrNotificationChannelLimitReached
		}
		row := tx.QueryRow(ctx,
			`INSERT INTO workspace_notification_channels (
				workspace_id, name, kind, config_enc, config_hint, events, enabled, created_by
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7, $8
			) RETURNING `+notifChannelSelectCols,
			wsID, cand.Name, cand.Kind, cand.ConfigEnc, cand.ConfigHint, cand.Events, cand.Enabled, guard.UserID,
		)
		out, e = scanNotificationChannel(row, false)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, notifChannelPGError(err)
}

func (p *Postgres) UpdateNotificationChannel(ctx context.Context, guard RestoreGuard, wsID, channelID int64, patch NotificationChannelPatch) (out NotificationChannel, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		cur, e := scanNotificationChannel(tx.QueryRow(ctx,
			`SELECT `+notifChannelSelectCols+`
			   FROM workspace_notification_channels
			  WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
			channelID, wsID), true)
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		if patch.Name != nil {
			cur.Name = *patch.Name
		}
		if patch.Kind != nil {
			cur.Kind = *patch.Kind
		}
		if patch.UpdateConfig {
			cur.ConfigEnc = patch.ConfigEnc
			cur.ConfigHint = patch.ConfigHint
		}
		if patch.Events != nil {
			cur.Events = append([]string(nil), (*patch.Events)...)
		}
		if patch.Enabled != nil {
			cur.Enabled = *patch.Enabled
		}
		if e = validateNotificationChannelFields(&cur); e != nil {
			return e
		}
		out, e = scanNotificationChannel(tx.QueryRow(ctx,
			`UPDATE workspace_notification_channels
			    SET name = $3, kind = $4, config_enc = $5, config_hint = $6,
			        events = $7, enabled = $8, updated_at = now()
			  WHERE id = $1 AND workspace_id = $2
			  RETURNING `+notifChannelSelectCols,
			channelID, wsID,
			cur.Name, cur.Kind, cur.ConfigEnc, cur.ConfigHint,
			cur.Events, cur.Enabled,
		), false)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, notifChannelPGError(err)
}

func (p *Postgres) DeleteNotificationChannel(ctx context.Context, guard RestoreGuard, wsID, channelID int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `DELETE FROM workspace_notification_channels WHERE id = $1 AND workspace_id = $2`, channelID, wsID)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return notifChannelPGError(err)
}

func (p *Postgres) ListActiveNotificationChannelsForEvent(ctx context.Context, wsID int64, event string) ([]NotificationChannel, error) {
	target := strings.ToLower(strings.TrimSpace(event))
	if target == "" {
		return []NotificationChannel{}, nil
	}
	rows, err := p.Pool.Query(ctx,
		`SELECT `+notifChannelSelectCols+`
		   FROM workspace_notification_channels
		  WHERE workspace_id = $1
		    AND enabled = true
		    AND $2 = ANY(events)
		  ORDER BY id ASC`, wsID, target)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]NotificationChannel, 0)
	for rows.Next() {
		item, err := scanNotificationChannel(rows, true)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (p *Postgres) RecordNotificationChannelDelivery(ctx context.Context, wsID, channelID int64, status, errMsg string, sentAt time.Time) error {
	if sentAt.IsZero() {
		sentAt = time.Now().UTC()
	} else {
		sentAt = sentAt.UTC()
	}
	cleanStatus := clampNotificationRunes(status, maxNotificationChannelStatusRunes)
	cleanErr := truncateUTF8Bytes(strings.ToValidUTF8(strings.TrimSpace(errMsg), ""), maxNotificationChannelErrorBytes)
	tag, err := p.Pool.Exec(ctx,
		`UPDATE workspace_notification_channels
		    SET last_status = $3, last_error = $4, last_sent_at = $5
		  WHERE id = $1 AND workspace_id = $2`,
		channelID, wsID, cleanStatus, cleanErr, sentAt)
	if err != nil {
		return notifChannelPGError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
