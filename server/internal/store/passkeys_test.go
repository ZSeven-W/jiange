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

type passkeyTestStore interface {
	store.Store
	store.PasskeyStore
}

func exercisePasskeys(t *testing.T, st passkeyTestStore) {
	t.Helper()
	ctx := context.Background()
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)

	alice, _, err := st.CreateUser(ctx, "pk-alice@example.test", "Alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	bob, _, err := st.CreateUser(ctx, "pk-bob@example.test", "Bob", "hash")
	if err != nil {
		t.Fatal(err)
	}

	// 1. Challenge lifecycle: create, wrong purpose fails without consuming, valid consume succeeds once, replay fails.
	aliceID := alice.ID
	regCh := store.WebAuthnChallenge{
		Challenge: "reg-challenge-abc123",
		UserID:    &aliceID,
		Purpose:   store.WebAuthnPurposeRegister,
		RPID:      "docs.example.test",
		Origin:    "https://docs.example.test",
		ExpiresAt: now.Add(5 * time.Minute),
		CreatedAt: now,
	}
	if err := st.CreateWebAuthnChallenge(ctx, regCh); err != nil {
		t.Fatalf("CreateWebAuthnChallenge(register): %v", err)
	}
	// Wrong purpose must not consume it.
	if _, err := st.ConsumeWebAuthnChallenge(ctx, regCh.Challenge, store.WebAuthnPurposeLogin, now.Add(time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("consume wrong purpose = %v, want ErrNotFound", err)
	}
	gotCh, err := st.ConsumeWebAuthnChallenge(ctx, regCh.Challenge, store.WebAuthnPurposeRegister, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("ConsumeWebAuthnChallenge(register): %v", err)
	}
	if gotCh.Challenge != regCh.Challenge || gotCh.UserID == nil || *gotCh.UserID != alice.ID || gotCh.RPID != "docs.example.test" || gotCh.Origin != "https://docs.example.test" {
		t.Fatalf("unexpected consumed challenge: %+v", gotCh)
	}
	// Replay must fail.
	if _, err := st.ConsumeWebAuthnChallenge(ctx, regCh.Challenge, store.WebAuthnPurposeRegister, now.Add(time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("replay consume = %v, want ErrNotFound", err)
	}

	// Expired challenge (discoverable login with nil UserID) must fail.
	loginCh := store.WebAuthnChallenge{
		Challenge: "login-challenge-xyz",
		UserID:    nil,
		Purpose:   store.WebAuthnPurposeLogin,
		RPID:      "docs.example.test",
		Origin:    "https://docs.example.test",
		ExpiresAt: now.Add(5 * time.Minute),
		CreatedAt: now,
	}
	if err := st.CreateWebAuthnChallenge(ctx, loginCh); err != nil {
		t.Fatalf("CreateWebAuthnChallenge(login): %v", err)
	}
	if _, err := st.ConsumeWebAuthnChallenge(ctx, loginCh.Challenge, store.WebAuthnPurposeLogin, now.Add(6*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired challenge = %v, want ErrNotFound", err)
	}

	// Invalid challenge params rejected.
	if err := st.CreateWebAuthnChallenge(ctx, store.WebAuthnChallenge{Challenge: "bad", Purpose: "unknown", ExpiresAt: now.Add(time.Minute)}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid purpose err = %v, want ErrConflict", err)
	}
	missingUID := int64(99999)
	if err := st.CreateWebAuthnChallenge(ctx, store.WebAuthnChallenge{Challenge: "missing-user", UserID: &missingUID, Purpose: store.WebAuthnPurposeRegister, ExpiresAt: now.Add(time.Minute)}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing user challenge err = %v, want ErrNotFound", err)
	}

	// 2. Passkey CRUD, duplicate credential rejection, signCount update, and user isolation.
	list, err := st.ListUserPasskeys(ctx, alice.ID)
	if err != nil || list == nil || len(list) != 0 {
		t.Fatalf("initial ListUserPasskeys = (%v, %v), want empty non-nil", list, err)
	}

	cred1 := []byte{0x01, 0x02, 0x03, 0x04, 0x05}
	cose1 := []byte{0xa5, 0x01, 0x02}
	pk1, err := st.CreateUserPasskey(ctx, store.UserPasskey{
		UserID:        alice.ID,
		CredentialID:  cred1,
		PublicKeyCOSE: cose1,
		SignCount:     0,
		AAGUID:        "00000000-0000-0000-0000-000000000001",
		Transports:    []string{"INTERNAL", "hybrid", "internal", "  "},
		Name:          "  MacBook Touch ID  ",
		CreatedAt:     now,
	})
	if err != nil {
		t.Fatalf("CreateUserPasskey(1): %v", err)
	}
	if pk1.ID <= 0 || pk1.Name != "MacBook Touch ID" || len(pk1.Transports) != 2 || pk1.Transports[0] != "internal" || pk1.Transports[1] != "hybrid" {
		t.Fatalf("unexpected pk1: %+v", pk1)
	}

	// Duplicate credential_id rejected even for another user.
	if _, err := st.CreateUserPasskey(ctx, store.UserPasskey{
		UserID:        bob.ID,
		CredentialID:  cred1,
		PublicKeyCOSE: cose1,
		Name:          "Dup Key",
	}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate credential err = %v, want ErrConflict", err)
	}

	// Second passkey with blank name defaults to "Passkey".
	cred2 := []byte{0x10, 0x20, 0x30}
	pk2, err := st.CreateUserPasskey(ctx, store.UserPasskey{
		UserID:        alice.ID,
		CredentialID:  cred2,
		PublicKeyCOSE: []byte{0xa4, 0x01, 0x03},
		SignCount:     3,
		Name:          "   ",
		CreatedAt:     now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("CreateUserPasskey(2): %v", err)
	}
	if pk2.Name != "Passkey" {
		t.Fatalf("default passkey name = %q, want Passkey", pk2.Name)
	}

	// List returns newest first.
	list, err = st.ListUserPasskeys(ctx, alice.ID)
	if err != nil || len(list) != 2 || list[0].ID != pk2.ID || list[1].ID != pk1.ID {
		t.Fatalf("ListUserPasskeys = (%+v, %v), want [pk2, pk1]", list, err)
	}

	// Lookup by credential ID.
	found, err := st.GetUserPasskeyByCredentialID(ctx, cred1)
	if err != nil || found.ID != pk1.ID || !bytes.Equal(found.PublicKeyCOSE, cose1) {
		t.Fatalf("GetUserPasskeyByCredentialID = (%+v, %v)", found, err)
	}
	if _, err := st.GetUserPasskeyByCredentialID(ctx, []byte{0xff}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing cred lookup = %v, want ErrNotFound", err)
	}

	// Update sign_count and last_used_at.
	usedAt := now.Add(10 * time.Minute)
	if err := st.UpdateUserPasskeySignCount(ctx, pk1.ID, 7, usedAt); err != nil {
		t.Fatalf("UpdateUserPasskeySignCount: %v", err)
	}
	foundAfter, err := st.GetUserPasskeyByCredentialID(ctx, cred1)
	if err != nil || foundAfter.SignCount != 7 || foundAfter.LastUsedAt == nil || !foundAfter.LastUsedAt.Equal(usedAt) {
		t.Fatalf("after UpdateUserPasskeySignCount = %+v err=%v", foundAfter, err)
	}
	if err := st.UpdateUserPasskeySignCount(ctx, 99999, 1, usedAt); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update missing passkey = %v, want ErrNotFound", err)
	}

	// Bob cannot delete Alice's passkey.
	if err := st.DeleteUserPasskey(ctx, bob.ID, pk1.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-user delete = %v, want ErrNotFound", err)
	}
	// Alice deletes pk1.
	if err := st.DeleteUserPasskey(ctx, alice.ID, pk1.ID); err != nil {
		t.Fatalf("DeleteUserPasskey: %v", err)
	}
	if err := st.DeleteUserPasskey(ctx, alice.ID, pk1.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("double delete = %v, want ErrNotFound", err)
	}
	list, err = st.ListUserPasskeys(ctx, alice.ID)
	if err != nil || len(list) != 1 || list[0].ID != pk2.ID {
		t.Fatalf("ListUserPasskeys after delete = (%+v, %v)", list, err)
	}
}

func TestPasskeyStoreMemory(t *testing.T) {
	exercisePasskeys(t, store.NewMemory())
}

func TestPasskeyStorePostgres(t *testing.T) {
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
	exercisePasskeys(t, pg)
}
