package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func exerciseAccountSecurityStore(t *testing.T, st interface {
	store.Store
	store.AccountSecurityStore
}) {
	t.Helper()
	ctx := context.Background()
	now := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)

	alice, _, err := st.CreateUser(ctx, fmt.Sprintf("sec-alice-%d@example.test", time.Now().UnixNano()), "Alice Security", "hash-v1")
	if err != nil {
		t.Fatalf("CreateUser alice: %v", err)
	}
	bob, _, err := st.CreateUser(ctx, fmt.Sprintf("sec-bob-%d@example.test", time.Now().UnixNano()), "Bob Security", "bob-hash")
	if err != nil {
		t.Fatalf("CreateUser bob: %v", err)
	}

	// Create 3 sessions for alice (2 active, 1 expired) and 1 session for bob.
	hashA1 := []byte("session-token-hash-alice-0000001")
	hashA2 := []byte("session-token-hash-alice-0000002")
	hashAExpired := []byte("session-token-hash-alice-expired")
	hashB1 := []byte("session-token-hash-bob-000000001")

	if err := st.CreateSession(ctx, hashA1, alice.ID, now.Add(2*time.Hour)); err != nil {
		t.Fatalf("CreateSession A1: %v", err)
	}
	if err := st.CreateSession(ctx, hashA2, alice.ID, now.Add(2*time.Hour)); err != nil {
		t.Fatalf("CreateSession A2: %v", err)
	}
	if err := st.CreateSession(ctx, hashAExpired, alice.ID, now.Add(-time.Minute)); err != nil {
		t.Fatalf("CreateSession AExpired: %v", err)
	}
	if err := st.CreateSession(ctx, hashB1, bob.ID, now.Add(2*time.Hour)); err != nil {
		t.Fatalf("CreateSession B1: %v", err)
	}

	// UpdateSessionMetadata stores UA (clamped) & IP & last_seen_at.
	longUA := "Mozilla/5.0 " + strings.Repeat("A", 300)
	if err := st.UpdateSessionMetadata(ctx, hashA1, longUA, "203.0.113.10", now.Add(1*time.Minute)); err != nil {
		t.Fatalf("UpdateSessionMetadata A1: %v", err)
	}
	if err := st.UpdateSessionMetadata(ctx, hashA2, "Safari/17.0 (iPhone)", "198.51.100.7", now.Add(5*time.Minute)); err != nil {
		t.Fatalf("UpdateSessionMetadata A2: %v", err)
	}
	if err := st.UpdateSessionMetadata(ctx, []byte("nonexistent-hash"), "UA", "1.2.3.4", now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("UpdateSessionMetadata missing = %v, want ErrNotFound", err)
	}

	// ListUserSessions orders by last_seen_at DESC, excludes expired & other users, marks Current, never exposes token_hash.
	sessions, err := st.ListUserSessions(ctx, alice.ID, hashA1, now.Add(6*time.Minute))
	if err != nil {
		t.Fatalf("ListUserSessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("expected 2 active sessions for alice, got %d: %+v", len(sessions), sessions)
	}
	if sessions[0].IPAddress != "198.51.100.7" || sessions[0].Current {
		t.Fatalf("expected newest session A2 first with Current=false, got %+v", sessions[0])
	}
	if sessions[1].IPAddress != "203.0.113.10" || !sessions[1].Current {
		t.Fatalf("expected A1 second with Current=true, got %+v", sessions[1])
	}
	if len([]rune(sessions[1].UserAgent)) != 256 {
		t.Fatalf("expected clamped userAgent length 256, got %d", len([]rune(sessions[1].UserAgent)))
	}
	// Verify JSON serialization does not contain raw token hashes.
	encoded, err := json.Marshal(sessions)
	if err != nil {
		t.Fatalf("json.Marshal sessions: %v", err)
	}
	if strings.Contains(string(encoded), "session-token-hash") || strings.Contains(string(encoded), "tokenHash") {
		t.Fatalf("serialized session leaked token hash: %s", string(encoded))
	}

	// TouchSession advances last_seen_at so A1 moves ahead of A2.
	if err := st.TouchSession(ctx, hashA1, now.Add(10*time.Minute)); err != nil {
		t.Fatalf("TouchSession A1: %v", err)
	}
	if err := st.TouchSession(ctx, hashAExpired, now.Add(10*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("TouchSession expired = %v, want ErrNotFound", err)
	}
	sessions, err = st.ListUserSessions(ctx, alice.ID, hashA1, now.Add(10*time.Minute))
	if err != nil {
		t.Fatalf("ListUserSessions after touch: %v", err)
	}
	if len(sessions) != 2 || !sessions[0].Current || sessions[0].IPAddress != "203.0.113.10" {
		t.Fatalf("expected touched session A1 first, got %+v", sessions)
	}

	// Cross-user revocation must fail with ErrNotFound.
	bobSessions, err := st.ListUserSessions(ctx, bob.ID, hashB1, now.Add(10*time.Minute))
	if err != nil || len(bobSessions) != 1 {
		t.Fatalf("ListUserSessions bob = (%+v, %v)", bobSessions, err)
	}
	if err := st.RevokeUserSession(ctx, alice.ID, bobSessions[0].ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-user RevokeUserSession = %v, want ErrNotFound", err)
	}

	// Revoke alice's A2 session by ID.
	a2ID := sessions[1].ID
	if err := st.RevokeUserSession(ctx, alice.ID, a2ID); err != nil {
		t.Fatalf("RevokeUserSession A2: %v", err)
	}
	if err := st.RevokeUserSession(ctx, alice.ID, a2ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("re-revoking A2 = %v, want ErrNotFound", err)
	}
	if _, err := st.SessionUser(ctx, hashA2, now.Add(11*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked A2 SessionUser = %v, want ErrNotFound", err)
	}

	// Add two more sessions for alice and revoke others keeping A1.
	hashA3 := []byte("session-token-hash-alice-0000003")
	hashA4 := []byte("session-token-hash-alice-0000004")
	if err := st.CreateSession(ctx, hashA3, alice.ID, now.Add(3*time.Hour)); err != nil {
		t.Fatalf("CreateSession A3: %v", err)
	}
	if err := st.CreateSession(ctx, hashA4, alice.ID, now.Add(3*time.Hour)); err != nil {
		t.Fatalf("CreateSession A4: %v", err)
	}
	revoked, err := st.RevokeOtherUserSessions(ctx, alice.ID, hashA1)
	if err != nil {
		t.Fatalf("RevokeOtherUserSessions keep A1: %v", err)
	}
	// A3, A4, plus expired AExpired are deleted (at least 2 active).
	if revoked < 2 {
		t.Fatalf("expected at least 2 revoked sessions, got %d", revoked)
	}
	if _, err := st.SessionUser(ctx, hashA1, now.Add(12*time.Minute)); err != nil {
		t.Fatalf("kept session A1 should still be valid: %v", err)
	}
	if _, err := st.SessionUser(ctx, hashA3, now.Add(12*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked session A3 should be invalid, got %v", err)
	}
	// Bob's session must remain untouched.
	if _, err := st.SessionUser(ctx, hashB1, now.Add(12*time.Minute)); err != nil {
		t.Fatalf("bob's session must remain valid: %v", err)
	}

	// RevokeOtherUserSessions with nil keepTokenHash revokes ALL of alice's sessions.
	revokedAll, err := st.RevokeOtherUserSessions(ctx, alice.ID, nil)
	if err != nil || revokedAll != 1 {
		t.Fatalf("RevokeOtherUserSessions(nil) = (%d, %v), want (1, nil)", revokedAll, err)
	}
	if _, err := st.SessionUser(ctx, hashA1, now.Add(12*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("A1 should be revoked after RevokeOtherUserSessions(nil), got %v", err)
	}

	// UpdateUserPasswordHash updates stored password hash.
	if err := st.UpdateUserPasswordHash(ctx, alice.ID, "hash-v2"); err != nil {
		t.Fatalf("UpdateUserPasswordHash: %v", err)
	}
	updatedAlice, err := st.UserByEmail(ctx, alice.Email)
	if err != nil {
		t.Fatalf("UserByEmail after password update: %v", err)
	}
	if updatedAlice.PasswordHash != "hash-v2" {
		t.Fatalf("expected hash-v2, got %q", updatedAlice.PasswordHash)
	}
	if err := st.UpdateUserPasswordHash(ctx, 99999999, "hash-x"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("UpdateUserPasswordHash missing = %v, want ErrNotFound", err)
	}

	// Password reset token lifecycle: create, single-use consume, replay rejection, expiry rejection.
	resetHash1 := []byte("reset-token-hash-000000000000001")
	if err := st.CreatePasswordResetToken(ctx, resetHash1, 99999999, now.Add(30*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("CreatePasswordResetToken unknown user = %v, want ErrNotFound", err)
	}
	if err := st.CreatePasswordResetToken(ctx, resetHash1, alice.ID, now.Add(30*time.Minute)); err != nil {
		t.Fatalf("CreatePasswordResetToken: %v", err)
	}

	// Concurrent consume race: exactly one caller must succeed.
	var (
		wg        sync.WaitGroup
		mu        sync.Mutex
		successes int
		gotUID    int64
	)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			uid, cErr := st.ConsumePasswordResetToken(ctx, resetHash1, now.Add(5*time.Minute))
			mu.Lock()
			defer mu.Unlock()
			if cErr == nil {
				successes++
				gotUID = uid
			} else if !errors.Is(cErr, store.ErrNotFound) {
				t.Errorf("unexpected concurrent consume err: %v", cErr)
			}
		}()
	}
	wg.Wait()
	if successes != 1 || gotUID != alice.ID {
		t.Fatalf("concurrent ConsumePasswordResetToken: successes=%d uid=%d, want 1 & %d", successes, gotUID, alice.ID)
	}

	// Replay after consumption fails.
	if _, err := st.ConsumePasswordResetToken(ctx, resetHash1, now.Add(6*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("replayed ConsumePasswordResetToken = %v, want ErrNotFound", err)
	}

	// Expired token is rejected.
	resetHashExpired := []byte("reset-token-hash-000000000000002")
	if err := st.CreatePasswordResetToken(ctx, resetHashExpired, alice.ID, now.Add(10*time.Minute)); err != nil {
		t.Fatalf("CreatePasswordResetToken expired: %v", err)
	}
	if _, err := st.ConsumePasswordResetToken(ctx, resetHashExpired, now.Add(10*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired ConsumePasswordResetToken = %v, want ErrNotFound", err)
	}
}

func TestAccountSecurityMemory(t *testing.T) {
	exerciseAccountSecurityStore(t, store.NewMemory())
}

func TestAccountSecurityPostgres(t *testing.T) {
	dsn := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("test_acct_sec_%d", time.Now().UnixNano())
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	pg := &store.Postgres{Pool: pool}
	exerciseAccountSecurityStore(t, pg)
}
