package storage

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestGenerateAndValidateID(t *testing.T) {
	id := GenerateID("doc_")
	if !strings.HasPrefix(id, "doc_") || len(id) != 20 {
		t.Fatalf("unexpected generated id: %q", id)
	}

	orig := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("entropy failure") }
	defer func() { randRead = orig }()
	fallback := GenerateID("fb_")
	if !strings.HasPrefix(fallback, "fb_") {
		t.Fatalf("expected fallback prefix, got %q", fallback)
	}

	for _, bad := range []string{"", ".", "..", "a/b", `a\b`, "a\x00b"} {
		if !errors.Is(ValidateID(bad), ErrInvalidID) {
			t.Fatalf("expected ErrInvalidID for %q", bad)
		}
	}
	if err := ValidateID("valid-id_123"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMemoryStore(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()

	if _, err := store.Get(ctx, ""); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID, got %v", err)
	}
	if _, err := store.Get(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if err := store.Put(ctx, nil); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID on nil, got %v", err)
	}
	if err := store.Put(ctx, &DocumentRecord{ID: "../bad"}); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID, got %v", err)
	}
	if err := store.Put(ctx, &DocumentRecord{ID: "d1", Version: 2}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("expected ErrVersionConflict for new doc with version!=0, got %v", err)
	}

	rec := &DocumentRecord{
		ID:       "doc-b",
		Kind:     "sheet",
		Title:    "Budget",
		Data:     []byte("v1"),
		Metadata: map[string]string{"owner": "alice"},
	}
	if err := store.Put(ctx, rec); err != nil {
		t.Fatalf("put failed: %v", err)
	}
	if rec.Version != 1 || rec.CreatedAt.IsZero() || rec.UpdatedAt.IsZero() {
		t.Fatalf("unexpected metadata after create: %+v", rec)
	}

	// Mutating caller slice/map must not mutate stored copy.
	rec.Data[0] = 'X'
	rec.Metadata["owner"] = "bob"
	got, err := store.Get(ctx, "doc-b")
	if err != nil || string(got.Data) != "v1" || got.Metadata["owner"] != "alice" {
		t.Fatalf("isolation violated: %+v err=%v", got, err)
	}

	// Optimistic conflict on stale version.
	stale := &DocumentRecord{ID: "doc-b", Kind: "sheet", Version: 0, Data: []byte("stale")}
	if err := store.Put(ctx, stale); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("expected ErrVersionConflict, got %v", err)
	}

	// Valid update increments version.
	got.Data = []byte("v2")
	if err := store.Put(ctx, got); err != nil {
		t.Fatalf("update failed: %v", err)
	}
	if got.Version != 2 {
		t.Fatalf("expected version 2, got %d", got.Version)
	}

	// Second doc for List sorting & kind filtering.
	if err := store.Put(ctx, &DocumentRecord{ID: "doc-a", Kind: "doc", Title: "Spec"}); err != nil {
		t.Fatalf("put doc-a failed: %v", err)
	}
	all, err := store.List(ctx, "")
	if err != nil || len(all) != 2 || all[0].ID != "doc-a" || all[1].ID != "doc-b" {
		t.Fatalf("unexpected list all: %+v err=%v", all, err)
	}
	sheets, err := store.List(ctx, "sheet")
	if err != nil || len(sheets) != 1 || sheets[0].ID != "doc-b" {
		t.Fatalf("unexpected list sheet: %+v err=%v", sheets, err)
	}

	// Delete error & success paths.
	if err := store.Delete(ctx, ""); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID, got %v", err)
	}
	if err := store.Delete(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if err := store.Delete(ctx, "doc-a"); err != nil {
		t.Fatalf("delete failed: %v", err)
	}

	// Concurrency safety under -race.
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			id := GenerateID("c_")
			_ = store.Put(ctx, &DocumentRecord{ID: id, Kind: "sheet", Data: []byte{byte(idx)}})
			_, _ = store.Get(ctx, id)
			_, _ = store.List(ctx, "sheet")
		}(i)
	}
	wg.Wait()
}

type failingTempFile struct {
	name     string
	writeErr error
	closeErr error
}

func (f *failingTempFile) Write(p []byte) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	return len(p), nil
}

func (f *failingTempFile) Close() error { return f.closeErr }
func (f *failingTempFile) Name() string { return f.name }

func TestFileStore(t *testing.T) {
	ctx := context.Background()

	// Invalid dir (file path blocking MkdirAll).
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFileStore(filepath.Join(blocker, "nested")); err == nil {
		t.Fatal("expected NewFileStore to fail when parent is a file")
	}

	dir := filepath.Join(t.TempDir(), "store")
	fs, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}

	// Validation & not-found checks.
	if _, err := fs.Get(ctx, "../x"); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID, got %v", err)
	}
	if _, err := fs.Get(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if err := fs.Put(ctx, nil); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID, got %v", err)
	}
	if err := fs.Put(ctx, &DocumentRecord{ID: "bad/id"}); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID, got %v", err)
	}
	if err := fs.Put(ctx, &DocumentRecord{ID: "d1", Version: 1}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("expected ErrVersionConflict, got %v", err)
	}

	// Create + Get + Update + Conflict.
	rec := &DocumentRecord{ID: "d2", Kind: "doc", Title: "Guide", Data: []byte("hello")}
	if err := fs.Put(ctx, rec); err != nil {
		t.Fatalf("put failed: %v", err)
	}
	if rec.Version != 1 {
		t.Fatalf("expected version 1, got %d", rec.Version)
	}
	loaded, err := fs.Get(ctx, "d2")
	if err != nil || string(loaded.Data) != "hello" {
		t.Fatalf("get failed: %+v err=%v", loaded, err)
	}
	if err := fs.Put(ctx, &DocumentRecord{ID: "d2", Version: 0}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}
	loaded.Data = []byte("world")
	if err := fs.Put(ctx, loaded); err != nil || loaded.Version != 2 {
		t.Fatalf("update failed: ver=%d err=%v", loaded.Version, err)
	}

	// Second record + non-json file & subdir skipped in List.
	if err := fs.Put(ctx, &DocumentRecord{ID: "d1", Kind: "sheet", Title: "Plan"}); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "ignore.txt"), []byte("x"), 0o644)
	_ = os.Mkdir(filepath.Join(dir, "subdir"), 0o755)

	all, err := fs.List(ctx, "")
	if err != nil || len(all) != 2 || all[0].ID != "d1" || all[1].ID != "d2" {
		t.Fatalf("unexpected list: %+v err=%v", all, err)
	}
	onlySheet, err := fs.List(ctx, "sheet")
	if err != nil || len(onlySheet) != 1 || onlySheet[0].ID != "d1" {
		t.Fatalf("unexpected filtered list: %+v err=%v", onlySheet, err)
	}

	// Corrupt JSON triggers unmarshal error in Get, Put, and List.
	corruptPath := filepath.Join(dir, "corrupt.json")
	if err := os.WriteFile(corruptPath, []byte("{bad json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := fs.Get(ctx, "corrupt"); err == nil {
		t.Fatal("expected unmarshal error on Get")
	}
	if err := fs.Put(ctx, &DocumentRecord{ID: "corrupt"}); err == nil {
		t.Fatal("expected read error on Put over corrupt file")
	}
	if _, err := fs.List(ctx, ""); err == nil {
		t.Fatal("expected read error on List with corrupt file")
	}
	_ = os.Remove(corruptPath)

	// Directory as record path triggers non-NotExist ReadFile error.
	dirAsFile := filepath.Join(dir, "isdir.json")
	_ = os.Mkdir(dirAsFile, 0o755)
	if _, err := fs.Get(ctx, "isdir"); err == nil {
		t.Fatal("expected error reading directory as file")
	}
	_ = os.Remove(dirAsFile)

	// Atomic temp file error paths: createTemp, Write, Close, Rename.
	origOps := fs.ops
	fs.ops.createTemp = func(string, string) (tempFile, error) { return nil, errors.New("create fail") }
	if err := fs.Put(ctx, &DocumentRecord{ID: "d3"}); err == nil {
		t.Fatal("expected createTemp failure")
	}
	fs.ops.createTemp = func(string, string) (tempFile, error) {
		return &failingTempFile{name: "tmp", writeErr: errors.New("write fail")}, nil
	}
	if err := fs.Put(ctx, &DocumentRecord{ID: "d3"}); err == nil {
		t.Fatal("expected write failure")
	}
	fs.ops.createTemp = func(string, string) (tempFile, error) {
		return &failingTempFile{name: "tmp", closeErr: errors.New("close fail")}, nil
	}
	if err := fs.Put(ctx, &DocumentRecord{ID: "d3"}); err == nil {
		t.Fatal("expected close failure")
	}
	fs.ops.createTemp = origOps.createTemp
	fs.ops.rename = func(string, string) error { return errors.New("rename fail") }
	if err := fs.Put(ctx, &DocumentRecord{ID: "d3"}); err == nil {
		t.Fatal("expected rename failure")
	}
	fs.ops = origOps

	// Delete error & success paths.
	if err := fs.Delete(ctx, ""); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("expected ErrInvalidID, got %v", err)
	}
	if err := fs.Delete(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if err := fs.Delete(ctx, "d1"); err != nil {
		t.Fatalf("delete failed: %v", err)
	}

	// List error when directory does not exist.
	badFS := &FileStore{dir: filepath.Join(t.TempDir(), "nonexistent"), ops: defaultFileOps()}
	if _, err := badFS.List(ctx, ""); err == nil {
		t.Fatal("expected List error on missing directory")
	}
}

func TestAuthAndMiddleware(t *testing.T) {
	// Context helpers
	if p, ok := PrincipalFromContext(context.Background()); ok || p != nil {
		t.Fatalf("expected empty principal, got %+v %v", p, ok)
	}
	ctx := WithPrincipal(context.Background(), &Principal{ID: "u1", Roles: []string{"editor"}})
	if p, ok := PrincipalFromContext(ctx); !ok || p.ID != "u1" {
		t.Fatalf("expected u1, got %+v %v", p, ok)
	}

	// BearerTokenAuth
	auth := NewBearerTokenAuth(map[string]Principal{
		"tok-editor": {ID: "u1", Name: "Alice", Roles: []string{"editor"}, Metadata: map[string]string{"org": "acme"}},
		"tok-viewer": {ID: "u2", Name: "Bob", Roles: []string{"viewer"}},
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, err := auth.Authenticate(req); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected ErrUnauthenticated, got %v", err)
	}
	req.Header.Set("Authorization", "Bearer   ")
	if _, err := auth.Authenticate(req); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected ErrUnauthenticated on empty token, got %v", err)
	}
	req.Header.Set("Authorization", "Bearer wrong")
	if _, err := auth.Authenticate(req); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expected ErrUnauthenticated on wrong token, got %v", err)
	}
	req.Header.Set("Authorization", "bearer tok-editor")
	p, err := auth.Authenticate(req)
	if err != nil || p.ID != "u1" || p.Metadata["org"] != "acme" {
		t.Fatalf("unexpected principal: %+v err=%v", p, err)
	}

	// AllowAllAuthorizer & RoleAuthorizer
	if err := (AllowAllAuthorizer{}).Authorize(ctx, nil, "doc1", ActionAdmin); err != nil {
		t.Fatalf("AllowAllAuthorizer failed: %v", err)
	}
	defaultRBAC := NewRoleAuthorizer(nil)
	if err := defaultRBAC.Authorize(ctx, nil, "doc1", ActionRead); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden for nil principal, got %v", err)
	}
	if err := defaultRBAC.Authorize(ctx, &Principal{Roles: []string{"viewer"}}, "doc1", ActionRead); err != nil {
		t.Fatalf("viewer should read: %v", err)
	}
	if err := defaultRBAC.Authorize(ctx, &Principal{Roles: []string{"viewer"}}, "doc1", ActionWrite); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer should not write: %v", err)
	}
	customRBAC := NewRoleAuthorizer(map[Action][]string{ActionAdmin: {"super"}})
	if err := customRBAC.Authorize(ctx, &Principal{Roles: []string{"super"}}, "doc1", ActionAdmin); err != nil {
		t.Fatalf("super should admin: %v", err)
	}

	// AuthMiddleware tests
	var capturedDocID, capturedUser string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if pr, ok := PrincipalFromContext(r.Context()); ok {
			capturedUser = pr.ID
		}
		w.WriteHeader(http.StatusOK)
	})
	docIDFn := func(r *http.Request) string {
		capturedDocID = r.URL.Query().Get("id")
		return capturedDocID
	}

	// 401 when unauthenticated
	mw := AuthMiddleware(auth, defaultRBAC, docIDFn, ActionWrite, next)
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/?id=d1", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	// 403 when viewer tries ActionWrite
	rec = httptest.NewRecorder()
	rViewer := httptest.NewRequest(http.MethodPost, "/?id=d1", nil)
	rViewer.Header.Set("Authorization", "Bearer tok-viewer")
	mw.ServeHTTP(rec, rViewer)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}

	// 200 when editor tries ActionWrite
	rec = httptest.NewRecorder()
	rEditor := httptest.NewRequest(http.MethodPost, "/?id=d9", nil)
	rEditor.Header.Set("Authorization", "Bearer tok-editor")
	mw.ServeHTTP(rec, rEditor)
	if rec.Code != http.StatusOK || capturedUser != "u1" || capturedDocID != "d9" {
		t.Fatalf("unexpected 200 result: code=%d user=%q doc=%q", rec.Code, capturedUser, capturedDocID)
	}

	// Auth nil with principal already in context
	mwAuthzOnly := AuthMiddleware(nil, defaultRBAC, nil, ActionRead, next)
	rec = httptest.NewRecorder()
	rPreAuth := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(
		WithPrincipal(context.Background(), &Principal{ID: "u-ctx", Roles: []string{"viewer"}}),
	)
	mwAuthzOnly.ServeHTTP(rec, rPreAuth)
	if rec.Code != http.StatusOK || capturedUser != "u-ctx" {
		t.Fatalf("expected pre-authenticated context principal to pass, code=%d user=%q", rec.Code, capturedUser)
	}
}

func TestWebhookDispatcherAndVerifySignature(t *testing.T) {
	secret := "super-secret-key"
	var gotSig string
	var gotBody []byte
	statusToReturn := http.StatusOK

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSig = r.Header.Get(SignatureHeader)
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(statusToReturn)
	}))
	defer srv.Close()

	dispatcher := NewWebhookDispatcher(srv.URL, secret, nil)
	err := dispatcher.Dispatch(context.Background(), WebhookEvent{
		Type:    "sheet.updated",
		DocID:   "s1",
		Kind:    "sheet",
		Payload: map[string]any{"version": 2},
	})
	if err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}
	if !VerifySignature(secret, gotBody, gotSig) {
		t.Fatalf("signature verification failed: sig=%q", gotSig)
	}
	if VerifySignature("wrong-secret", gotBody, gotSig) {
		t.Fatal("expected verification failure for wrong secret")
	}

	// Non-2xx status error
	statusToReturn = http.StatusInternalServerError
	if err := dispatcher.Dispatch(context.Background(), WebhookEvent{Type: "sheet.updated"}); err == nil {
		t.Fatal("expected error for 500 response")
	}

	// Marshal error
	if err := dispatcher.Dispatch(context.Background(), WebhookEvent{
		Type:    "bad",
		Payload: map[string]any{"fn": func() {}},
	}); err == nil {
		t.Fatal("expected json marshal error")
	}

	// Invalid URL error
	badURLDispatcher := NewWebhookDispatcher("://bad-url", secret, srv.Client())
	if err := badURLDispatcher.Dispatch(context.Background(), WebhookEvent{Type: "x"}); err == nil {
		t.Fatal("expected request creation error")
	}

	// Network error (closed server)
	srv.Close()
	if err := dispatcher.Dispatch(context.Background(), WebhookEvent{Type: "x"}); err == nil {
		t.Fatal("expected transport error against closed server")
	}
}
