package store_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type patTestStore interface {
	store.Store
	store.PATStore
}

func patTestHash(seed string) []byte {
	sum := sha256.Sum256([]byte(seed))
	return sum[:]
}

func exercisePATStore(t *testing.T, st patTestStore) {
	t.Helper()
	ctx := context.Background()

	alice, _, err := st.CreateUser(ctx, "pat-alice@example.test", "Alice", "pw-hash")
	if err != nil {
		t.Fatal(err)
	}
	bob, _, err := st.CreateUser(ctx, "pat-bob@example.test", "Bob", "pw-hash")
	if err != nil {
		t.Fatal(err)
	}

	// Initially empty (non-nil slice).
	initial, err := st.ListPersonalAccessTokens(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if initial == nil || len(initial) != 0 {
		t.Fatalf("initial list = %#v, want empty non-nil slice", initial)
	}

	// Validation: invalid name (empty / whitespace / >80 runes), empty or invalid scopes, empty hash/prefix, missing user.
	if _, err := st.CreatePersonalAccessToken(ctx, 999999, "Ghost", "jg_pat_1234567", patTestHash("ghost"), []string{"read"}, nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing user err = %v, want ErrNotFound", err)
	}
	for _, badName := range []string{"", "   ", strings.Repeat("令", 81)} {
		if _, err := st.CreatePersonalAccessToken(ctx, alice.ID, badName, "jg_pat_1234567", patTestHash("bad-name-"+badName), []string{"read"}, nil); !errors.Is(err, store.ErrConflict) {
			t.Fatalf("bad name %q err = %v, want ErrConflict", badName, err)
		}
	}
	// Exactly 80 CJK runes is accepted.
	maxName := strings.Repeat("令", 80)
	maxNameTok, err := st.CreatePersonalAccessToken(ctx, alice.ID, "  "+maxName+"  ", "jg_pat_maxname", patTestHash("max-name"), []string{"write", "read", "write"}, nil)
	if err != nil {
		t.Fatalf("80-rune name should succeed: %v", err)
	}
	if maxNameTok.Name != maxName {
		t.Fatalf("trimmed name mismatch: got len=%d", len(maxNameTok.Name))
	}
	if len(maxNameTok.Scopes) != 2 || maxNameTok.Scopes[0] != "read" || maxNameTok.Scopes[1] != "write" {
		t.Fatalf("normalized scopes = %v, want [read write]", maxNameTok.Scopes)
	}

	for _, badScopes := range [][]string{nil, {}, {"read", "superadmin"}, {"unknown"}} {
		if _, err := st.CreatePersonalAccessToken(ctx, alice.ID, "Bad Scopes", "jg_pat_badscop", patTestHash("bad-scopes"), badScopes, nil); !errors.Is(err, store.ErrConflict) {
			t.Fatalf("bad scopes %v err = %v, want ErrConflict", badScopes, err)
		}
	}
	if _, err := st.CreatePersonalAccessToken(ctx, alice.ID, "Empty Hash", "jg_pat_nohash1", nil, []string{"read"}, nil); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("empty hash err = %v, want ErrConflict", err)
	}
	if _, err := st.CreatePersonalAccessToken(ctx, alice.ID, "Empty Prefix", "   ", patTestHash("no-prefix"), []string{"read"}, nil); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("empty prefix err = %v, want ErrConflict", err)
	}

	// Duplicate hash rejected.
	if _, err := st.CreatePersonalAccessToken(ctx, alice.ID, "Dup Hash", "jg_pat_duphash", patTestHash("max-name"), []string{"read"}, nil); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate hash err = %v, want ErrConflict", err)
	}

	// Create a second token with explicit expiry and check newest-first ordering.
	expFuture := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second)
	hash2 := patTestHash("alice-token-2")
	tok2, err := st.CreatePersonalAccessToken(ctx, alice.ID, "CI Deploy", "jg_pat_AbCdEfG", hash2, []string{"admin"}, &expFuture)
	if err != nil {
		t.Fatal(err)
	}
	if tok2.ExpiresAt == nil || !tok2.ExpiresAt.Equal(expFuture) {
		t.Fatalf("expiresAt = %v, want %v", tok2.ExpiresAt, expFuture)
	}

	// Bob creates a token — Alice must not see it.
	bobHash := patTestHash("bob-token-1")
	bobTok, err := st.CreatePersonalAccessToken(ctx, bob.ID, "Bob Script", "jg_pat_BobTok1", bobHash, []string{"read"}, nil)
	if err != nil {
		t.Fatal(err)
	}

	aliceList, err := st.ListPersonalAccessTokens(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(aliceList) != 2 {
		t.Fatalf("alice list len = %d, want 2", len(aliceList))
	}
	if aliceList[0].ID != tok2.ID || aliceList[1].ID != maxNameTok.ID {
		t.Fatalf("list order = [%d, %d], want newest-first [%d, %d]", aliceList[0].ID, aliceList[1].ID, tok2.ID, maxNameTok.ID)
	}

	// JSON representation must never include hash fields.
	rawJSON, err := json.Marshal(aliceList[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rawJSON), "tokenHash") || strings.Contains(string(rawJSON), "token_hash") {
		t.Fatalf("PAT JSON leaked hash field: %s", string(rawJSON))
	}

	// Authenticate active token updates last_used_at.
	authTime := time.Now().UTC().Add(5 * time.Minute).Truncate(time.Second)
	authRes, err := st.AuthenticatePersonalAccessToken(ctx, hash2, authTime)
	if err != nil {
		t.Fatalf("authenticate active token: %v", err)
	}
	if authRes.User.ID != alice.ID || authRes.User.Email != alice.Email {
		t.Fatalf("authenticated user = %+v, want alice", authRes.User)
	}
	if authRes.Token.ID != tok2.ID || authRes.Token.LastUsedAt == nil || !authRes.Token.LastUsedAt.Equal(authTime) {
		t.Fatalf("authenticated token = %+v, want lastUsedAt=%v", authRes.Token, authTime)
	}

	// Verify last_used_at persisted in list output.
	aliceList, err = st.ListPersonalAccessTokens(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if aliceList[0].LastUsedAt == nil || !aliceList[0].LastUsedAt.Equal(authTime) {
		t.Fatalf("persisted lastUsedAt = %v, want %v", aliceList[0].LastUsedAt, authTime)
	}

	// Expired token (at exact expiry boundary and after expiry) fails authentication.
	if _, err := st.AuthenticatePersonalAccessToken(ctx, hash2, expFuture); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("at exact expiry err = %v, want ErrNotFound", err)
	}
	if _, err := st.AuthenticatePersonalAccessToken(ctx, hash2, expFuture.Add(time.Second)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("after expiry err = %v, want ErrNotFound", err)
	}

	// Unknown / empty hash fails authentication.
	if _, err := st.AuthenticatePersonalAccessToken(ctx, patTestHash("does-not-exist"), authTime); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown hash err = %v, want ErrNotFound", err)
	}
	if _, err := st.AuthenticatePersonalAccessToken(ctx, nil, authTime); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("empty hash err = %v, want ErrNotFound", err)
	}

	// Cross-user revocation must return ErrNotFound and leave Bob's token active.
	revokeTime := authTime.Add(time.Minute)
	if err := st.RevokePersonalAccessToken(ctx, alice.ID, bobTok.ID, revokeTime); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-user revoke err = %v, want ErrNotFound", err)
	}
	if _, err := st.AuthenticatePersonalAccessToken(ctx, bobHash, revokeTime); err != nil {
		t.Fatalf("bob token should remain valid after alice failed revoke: %v", err)
	}

	// Missing token revocation returns ErrNotFound.
	if err := st.RevokePersonalAccessToken(ctx, alice.ID, 999999, revokeTime); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing token revoke err = %v, want ErrNotFound", err)
	}

	// Owner revokes tok2 -> subsequent authentication fails, revoked_at is recorded & preserved on repeat revoke.
	if err := st.RevokePersonalAccessToken(ctx, alice.ID, tok2.ID, revokeTime); err != nil {
		t.Fatalf("owner revoke: %v", err)
	}
	if _, err := st.AuthenticatePersonalAccessToken(ctx, hash2, revokeTime.Add(time.Second)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked token auth err = %v, want ErrNotFound", err)
	}
	// Repeat revoke is idempotent and preserves original revoked_at.
	if err := st.RevokePersonalAccessToken(ctx, alice.ID, tok2.ID, revokeTime.Add(time.Hour)); err != nil {
		t.Fatalf("idempotent revoke: %v", err)
	}
	aliceList, err = st.ListPersonalAccessTokens(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if aliceList[0].RevokedAt == nil || !aliceList[0].RevokedAt.Equal(revokeTime) {
		t.Fatalf("revokedAt = %v, want %v", aliceList[0].RevokedAt, revokeTime)
	}

	// Max 50 active tokens per user:
	// Alice currently has 1 active (maxNameTok) and 1 revoked (tok2).
	// Also create 1 already-expired token to confirm expired tokens don't count toward active quota.
	past := time.Now().UTC().Add(-time.Hour)
	if _, err := st.CreatePersonalAccessToken(ctx, alice.ID, "Already Expired", "jg_pat_expired", patTestHash("already-expired"), []string{"read"}, &past); err != nil {
		t.Fatalf("create expired token: %v", err)
	}
	// Fill remaining 49 active slots (total active = 50).
	var lastActive store.PersonalAccessToken
	for i := 2; i <= store.MaxActivePATsPerUser; i++ {
		tok, err := st.CreatePersonalAccessToken(
			ctx,
			alice.ID,
			fmt.Sprintf("Active Token %02d", i),
			fmt.Sprintf("jg_pat_act%04d", i),
			patTestHash(fmt.Sprintf("active-slot-%d", i)),
			[]string{"read"},
			nil,
		)
		if err != nil {
			t.Fatalf("create active slot %d: %v", i, err)
		}
		lastActive = tok
	}

	// 51st active token must fail with ErrConflict.
	if _, err := st.CreatePersonalAccessToken(ctx, alice.ID, "Overflow", "jg_pat_overflw", patTestHash("overflow-51"), []string{"read"}, nil); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("51st active token err = %v, want ErrConflict", err)
	}

	// Bob still has quota available (per-user limit).
	if _, err := st.CreatePersonalAccessToken(ctx, bob.ID, "Bob Second", "jg_pat_BobTok2", patTestHash("bob-token-2"), []string{"read"}, nil); err != nil {
		t.Fatalf("bob quota should be unaffected by alice: %v", err)
	}

	// Revoking one of Alice's active tokens frees up a slot.
	if err := st.RevokePersonalAccessToken(ctx, alice.ID, lastActive.ID, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreatePersonalAccessToken(ctx, alice.ID, "Recovered Slot", "jg_pat_recovrd", patTestHash("recovered-50"), []string{"write"}, nil); err != nil {
		t.Fatalf("create after revoke should succeed: %v", err)
	}
}

func TestPATStoreMemory(t *testing.T) {
	exercisePATStore(t, store.NewMemory())
}

func TestPATStorePostgres(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pg, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err := pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	exercisePATStore(t, pg)
}
