package store

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"time"
	"weak"

	"github.com/jackc/pgx/v5"
)

const (
	// RealtimeChannelBt carries cross-replica bitable invalidation notifications.
	RealtimeChannelBt = "jiange_bt_events"
	// RealtimeChannelSheet carries cross-replica spreadsheet revision and cursor presence notifications.
	RealtimeChannelSheet = "jiange_sheet_events"
	// RealtimeChannelSlides carries cross-replica presentation revision, presence, and presenter sync notifications.
	RealtimeChannelSlides = "jiange_slides_events"

	// MaxRealtimePayloadBytes stays strictly below PostgreSQL's 8000-byte NOTIFY payload limit.
	MaxRealtimePayloadBytes = 7999

	realtimeSubBufferSize  = 256
	realtimeInitialBackoff = 250 * time.Millisecond
	realtimeMaxBackoff     = 5 * time.Second
)

// ErrRealtimePayloadTooLarge indicates a publish payload exceeded PostgreSQL's
// 8000-byte NOTIFY limit.
var ErrRealtimePayloadTooLarge = fmt.Errorf("store: realtime payload exceeds %d bytes: %w", MaxRealtimePayloadBytes, ErrInvalidInput)

// RealtimeBus provides cross-replica pub/sub fan-out for realtime sync hubs.
// Postgres implements it with LISTEN/NOTIFY; Memory and MemoryRealtimeBus
// provide an in-process implementation for single-node and multi-hub tests.
type RealtimeBus interface {
	PublishRealtime(ctx context.Context, channel, payload string) error
	ListenRealtime(ctx context.Context, channel string, onMessage func(payload string)) error
}

var (
	_ RealtimeBus = (*Memory)(nil)
	_ RealtimeBus = (*MemoryRealtimeBus)(nil)
	_ RealtimeBus = (*Postgres)(nil)
)

// ValidateRealtimeChannel enforces a strict lowercase PostgreSQL identifier
// (^[a-z][a-z0-9_]{0,62}$) so LISTEN <channel> can never be SQL-injected.
func ValidateRealtimeChannel(channel string) error {
	if len(channel) == 0 || len(channel) > 63 {
		return fmt.Errorf("%w: invalid realtime channel", ErrInvalidInput)
	}
	for i := 0; i < len(channel); i++ {
		c := channel[i]
		if i == 0 {
			if c < 'a' || c > 'z' {
				return fmt.Errorf("%w: invalid realtime channel", ErrInvalidInput)
			}
			continue
		}
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
			return fmt.Errorf("%w: invalid realtime channel", ErrInvalidInput)
		}
	}
	return nil
}

func validateRealtimePublish(channel, payload string) error {
	if err := ValidateRealtimeChannel(channel); err != nil {
		return err
	}
	if len(payload) > MaxRealtimePayloadBytes {
		return ErrRealtimePayloadTooLarge
	}
	return nil
}

// MemoryRealtimeBus is an in-process RealtimeBus for tests and single-process
// multi-hub deployments.
type MemoryRealtimeBus struct {
	mu     sync.RWMutex
	nextID uint64
	subs   map[string]map[uint64]chan string
}

// NewMemoryRealtimeBus returns an initialized in-process RealtimeBus.
func NewMemoryRealtimeBus() *MemoryRealtimeBus {
	return &MemoryRealtimeBus{
		subs: map[string]map[uint64]chan string{},
	}
}

// PublishRealtime delivers payload to every active listener subscribed to channel.
func (b *MemoryRealtimeBus) PublishRealtime(ctx context.Context, channel, payload string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateRealtimePublish(channel, payload); err != nil {
		return err
	}
	b.mu.RLock()
	chans := b.subs[channel]
	for _, ch := range chans {
		select {
		case ch <- payload:
		default:
			// Never stall a publisher behind a dead or wedged listener.
		}
	}
	b.mu.RUnlock()
	return nil
}

// ListenRealtime subscribes to channel and invokes onMessage for each published
// payload until ctx is cancelled, returning nil on clean cancellation.
func (b *MemoryRealtimeBus) ListenRealtime(ctx context.Context, channel string, onMessage func(payload string)) error {
	if err := ValidateRealtimeChannel(channel); err != nil {
		return err
	}
	if onMessage == nil {
		return fmt.Errorf("%w: nil realtime message handler", ErrInvalidInput)
	}
	if ctx.Err() != nil {
		return nil
	}

	ch := make(chan string, realtimeSubBufferSize)
	b.mu.Lock()
	if b.subs == nil {
		b.subs = map[string]map[uint64]chan string{}
	}
	if b.subs[channel] == nil {
		b.subs[channel] = map[uint64]chan string{}
	}
	b.nextID++
	id := b.nextID
	b.subs[channel][id] = ch
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		if m := b.subs[channel]; m != nil {
			delete(m, id)
			if len(m) == 0 {
				delete(b.subs, channel)
			}
		}
		b.mu.Unlock()
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case payload := <-ch:
			onMessage(payload)
		}
	}
}

// SubscriberCount reports the active listener count for channel (useful in tests).
func (b *MemoryRealtimeBus) SubscriberCount(channel string) int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs[channel])
}

var memoryRealtimeBuses sync.Map // map[weak.Pointer[Memory]]*MemoryRealtimeBus

func (m *Memory) realtimeBus() *MemoryRealtimeBus {
	wp := weak.Make(m)
	if existing, ok := memoryRealtimeBuses.Load(wp); ok {
		return existing.(*MemoryRealtimeBus)
	}
	created := NewMemoryRealtimeBus()
	actual, loaded := memoryRealtimeBuses.LoadOrStore(wp, created)
	if !loaded {
		runtime.AddCleanup(m, func(k weak.Pointer[Memory]) {
			memoryRealtimeBuses.Delete(k)
		}, wp)
	}
	return actual.(*MemoryRealtimeBus)
}

// PublishRealtime publishes a cross-hub notification on the in-memory store's
// attached RealtimeBus.
func (m *Memory) PublishRealtime(ctx context.Context, channel, payload string) error {
	return m.realtimeBus().PublishRealtime(ctx, channel, payload)
}

// ListenRealtime listens for notifications on channel via the in-memory store's
// attached RealtimeBus until ctx is cancelled.
func (m *Memory) ListenRealtime(ctx context.Context, channel string, onMessage func(payload string)) error {
	return m.realtimeBus().ListenRealtime(ctx, channel, onMessage)
}

// RealtimeSubscriberCount reports the number of active listeners on channel.
func (m *Memory) RealtimeSubscriberCount(channel string) int {
	return m.realtimeBus().SubscriberCount(channel)
}

// PublishRealtime emits a PostgreSQL NOTIFY event on channel using pg_notify.
func (p *Postgres) PublishRealtime(ctx context.Context, channel, payload string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateRealtimePublish(channel, payload); err != nil {
		return err
	}
	_, err := p.Pool.Exec(ctx, `SELECT pg_notify($1, $2)`, channel, payload)
	return err
}

// ListenRealtime holds a dedicated PostgreSQL connection on LISTEN <channel>,
// invoking onMessage for each notification and reconnecting with exponential
// backoff on transient connection errors until ctx is cancelled.
func (p *Postgres) ListenRealtime(ctx context.Context, channel string, onMessage func(payload string)) error {
	if err := ValidateRealtimeChannel(channel); err != nil {
		return err
	}
	if onMessage == nil {
		return fmt.Errorf("%w: nil realtime message handler", ErrInvalidInput)
	}
	backoff := realtimeInitialBackoff
	for ctx.Err() == nil {
		connected, err := p.listenRealtimeOnce(ctx, channel, onMessage)
		if ctx.Err() != nil {
			return nil
		}
		if connected {
			backoff = realtimeInitialBackoff
		}
		_ = err
		timer := time.NewTimer(backoff)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil
		}
		backoff = min(backoff*2, realtimeMaxBackoff)
	}
	return nil
}

func (p *Postgres) listenRealtimeOnce(ctx context.Context, channel string, onMessage func(payload string)) (bool, error) {
	// Open a standalone connection outside pgxpool so long-lived LISTEN
	// subscribers never consume query pool slots on small 1-4 vCPU hosts.
	conn, err := pgx.ConnectConfig(ctx, p.Pool.Config().ConnConfig.Copy())
	if err != nil {
		return false, err
	}
	defer func() {
		_ = conn.Close(context.Background())
	}()
	if _, err := conn.Exec(ctx, "LISTEN "+channel); err != nil {
		return false, err
	}
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return true, err
		}
		if n.Channel == channel {
			onMessage(n.Payload)
		}
	}
}
