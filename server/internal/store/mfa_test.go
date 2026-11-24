package store_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseMFAStore(t *testing.T, st interface {
	store.Store
	store.MFAStore
}) {
	t.Helper()
	ctx := context.Background()
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)

	user, _, err := st.CreateUser(ctx, "mfa-user-"+now.Format("150405.000000000")+"@example.test", "Alice MFA", "pw-hash")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	// GetUserByIDForMFA returns the created user and ErrNotFound for unknown IDs.
	gotUser, err := st.GetUserByIDForMFA(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetUserByIDForMFA: %v", err)
	}
	if gotUser.ID != user.ID || gotUser.Email != user.Email || gotUser.PasswordHash != "pw-hash" {
		t.Fatalf("unexpected user: %+v", gotUser)
	}
	if _, err := st.GetUserByIDForMFA(ctx, 99999999); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected ErrNotFound for missing user, got %v", err)
	}

	// Never configured -> ErrNotFound.
	if _, err := st.GetUserMFA(ctx, user.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected ErrNotFound before setup, got %v", err)
	}

	// Upsert pending (disabled) MFA secret.
	secret1 := []byte("sealed-secret-v1")
	if err := st.UpsertUserMFA(ctx, store.UserMFAState{
		UserID:            user.ID,
		SecretEnc:         secret1,
		Enabled:           false,
		RecoveryCodesHash: []string{},
		UpdatedAt:         now,
	}); err != nil {
		t.Fatalf("UpsertUserMFA pending: %v", err)
	}
	// Mutating caller slice must not corrupt store state.
	secret1[0] = 'X'

	gotState, err := st.GetUserMFA(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetUserMFA pending: %v", err)
	}
	if gotState.Enabled || !bytes.Equal(gotState.SecretEnc, []byte("sealed-secret-v1")) || gotState.EnabledAt != nil || len(gotState.RecoveryCodesHash) != 0 {
		t.Fatalf("unexpected pending state: %+v", gotState)
	}

	// Upsert enabled MFA state with recovery code hashes.
	enabledAt := now.Add(time.Minute)
	hashes := []string{"hash-1", "hash-2", "hash-3"}
	if err := st.UpsertUserMFA(ctx, store.UserMFAState{
		UserID:            user.ID,
		SecretEnc:         []byte("sealed-secret-v2"),
		Enabled:           true,
		RecoveryCodesHash: hashes,
		EnabledAt:         &enabledAt,
		UpdatedAt:         enabledAt,
	}); err != nil {
		t.Fatalf("UpsertUserMFA enabled: %v", err)
	}
	gotState, err = st.GetUserMFA(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetUserMFA enabled: %v", err)
	}
	if !gotState.Enabled || !bytes.Equal(gotState.SecretEnc, []byte("sealed-secret-v2")) || gotState.EnabledAt == nil {
		t.Fatalf("unexpected enabled state: %+v", gotState)
	}
	if len(gotState.RecoveryCodesHash) != 3 || gotState.RecoveryCodesHash[0] != "hash-1" {
		t.Fatalf("unexpected recovery hashes: %+v", gotState.RecoveryCodesHash)
	}

	// Create, peek, and consume a single-use MFA challenge.
	tok1 := []byte("mfa-challenge-hash-1-000000000001")
	exp1 := now.Add(5 * time.Minute)
	if err := st.CreateMFAChallenge(ctx, tok1, user.ID, exp1); err != nil {
		t.Fatalf("CreateMFAChallenge: %v", err)
	}

	// Peek succeeds repeatedly while unexpired and does not consume.
	for i := 0; i < 2; i++ {
		uid, err := st.PeekMFAChallenge(ctx, tok1, now.Add(time.Minute))
		if err != nil || uid != user.ID {
			t.Fatalf("PeekMFAChallenge #%d = (%d, %v), want (%d, nil)", i, uid, err, user.ID)
		}
	}

	// Consume succeeds once and deletes the challenge.
	uid, err := st.ConsumeMFAChallenge(ctx, tok1, now.Add(2*time.Minute))
	if err != nil || uid != user.ID {
		t.Fatalf("ConsumeMFAChallenge = (%d, %v), want (%d, nil)", uid, err, user.ID)
	}
	// Replay must fail with ErrNotFound.
	if _, err := st.ConsumeMFAChallenge(ctx, tok1, now.Add(2*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("replayed ConsumeMFAChallenge = %v, want ErrNotFound", err)
	}
	if _, err := st.PeekMFAChallenge(ctx, tok1, now.Add(2*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("consumed PeekMFAChallenge = %v, want ErrNotFound", err)
	}

	// Expired challenge must be rejected on both peek and consume.
	tokExpired := []byte("mfa-challenge-hash-2-000000000002")
	if err := st.CreateMFAChallenge(ctx, tokExpired, user.ID, now.Add(5*time.Minute)); err != nil {
		t.Fatalf("CreateMFAChallenge expired: %v", err)
	}
	if _, err := st.PeekMFAChallenge(ctx, tokExpired, now.Add(5*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired PeekMFAChallenge = %v, want ErrNotFound", err)
	}
	tokExpired2 := []byte("mfa-challenge-hash-3-000000000003")
	if err := st.CreateMFAChallenge(ctx, tokExpired2, user.ID, now.Add(5*time.Minute)); err != nil {
		t.Fatalf("CreateMFAChallenge expired2: %v", err)
	}
	if _, err := st.ConsumeMFAChallenge(ctx, tokExpired2, now.Add(6*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired ConsumeMFAChallenge = %v, want ErrNotFound", err)
	}

	// DeleteUserMFA removes user MFA row and any pending challenges for the user.
	tokPending := []byte("mfa-challenge-hash-4-000000000004")
	if err := st.CreateMFAChallenge(ctx, tokPending, user.ID, now.Add(5*time.Minute)); err != nil {
		t.Fatalf("CreateMFAChallenge pending: %v", err)
	}
	if err := st.DeleteUserMFA(ctx, user.ID); err != nil {
		t.Fatalf("DeleteUserMFA: %v", err)
	}
	if _, err := st.GetUserMFA(ctx, user.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected ErrNotFound after DeleteUserMFA, got %v", err)
	}
	if _, err := st.PeekMFAChallenge(ctx, tokPending, now.Add(time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected pending challenge deleted after DeleteUserMFA, got %v", err)
	}
}

func TestMFAMemory(t *testing.T) {
	exerciseMFAStore(t, store.NewMemory())
}

func TestMFAPostgres(t *testing.T) {
	dsn := os.Getenv("JIANGE_TEST_DB")
	if dsn == "" {
		t.Skip("JIANGE_TEST_DB not set")
	}
	ctx := context.Background()
	pg, err := store.NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseMFAStore(t, pg)
}
