package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type clipboardAssetTestStore interface {
	Store
	CopyClipboardAssets(context.Context, RestoreGuard, ClipboardAssetCopy) (map[int64]int64, error)
}

func checkClipboardAssetStore(t *testing.T, st clipboardAssetTestStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "clip-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "clip-guest@test.dev", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	og := RestoreGuard{UserID: owner.ID, SessionHash: []byte("clip-owner-session")}
	gg := RestoreGuard{UserID: guest.ID, SessionHash: []byte("clip-guest-session")}
	for _, g := range []RestoreGuard{og, gg} {
		if err = st.CreateSession(ctx, g.SessionHash, g.UserID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	source, err := st.CreateDriveNode(ctx, og, ws.ID, nil, "doc", "源", true)
	if err != nil {
		t.Fatal(err)
	}
	target, err := st.CreateDriveNode(ctx, og, ws.ID, nil, "doc", "目标", true)
	if err != nil {
		t.Fatal(err)
	}
	file, err := st.CreateFile(ctx, FileMeta{DocID: source.ID, UploaderID: owner.ID, Name: "a.png", Mime: "image/png", Size: 3, ObjectKey: "clip-object-a"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := st.CreateFile(ctx, FileMeta{DocID: source.ID, UploaderID: owner.ID, Name: "b.png", Mime: "image/png", Size: 3, ObjectKey: "clip-object-b"})
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, source.ID, guest.ID, RoleView); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, target.ID, guest.ID, RoleEdit); err != nil {
		t.Fatal(err)
	}
	req := ClipboardAssetCopy{SourceDocID: source.ID, TargetDocID: target.ID, RequestID: "0123456789abcdef0123456789abcdef", FileIDs: []int64{file.ID}}
	first, err := st.CopyClipboardAssets(ctx, gg, req)
	if err != nil {
		t.Fatal(err)
	}
	if first[file.ID] == file.ID || first[file.ID] <= 0 {
		t.Fatalf("invalid copy: %v", first)
	}
	copyFile, err := st.GetFile(ctx, first[file.ID])
	if err != nil || copyFile.DocID != target.ID || copyFile.ObjectKey != file.ObjectKey {
		t.Fatalf("copy reference: %+v %v", copyFile, err)
	}
	retry, err := st.CopyClipboardAssets(ctx, gg, req)
	if err != nil || retry[file.ID] != first[file.ID] {
		t.Fatalf("retry: %v %v", retry, err)
	}
	concurrent := req
	concurrent.RequestID = "2123456789abcdef0123456789abcdef"
	type result struct {
		mapping map[int64]int64
		err     error
	}
	done := make(chan result, 6)
	for i := 0; i < 6; i++ {
		go func() { mapping, err := st.CopyClipboardAssets(ctx, gg, concurrent); done <- result{mapping, err} }()
	}
	var concurrentID int64
	for i := 0; i < 6; i++ {
		got := <-done
		if got.err != nil || got.mapping[file.ID] <= 0 {
			t.Fatalf("concurrent retry: %+v", got)
		}
		if i == 0 {
			concurrentID = got.mapping[file.ID]
		} else if got.mapping[file.ID] != concurrentID {
			t.Fatalf("concurrent requests produced different references: %+v", got)
		}
	}
	changed := req
	changed.FileIDs = []int64{other.ID}
	if _, err = st.CopyClipboardAssets(ctx, gg, changed); !errors.Is(err, ErrConflict) {
		t.Fatalf("request ID reused with different input: %v", err)
	}
	self := req
	self.TargetDocID = source.ID
	self.RequestID = "1123456789abcdef0123456789abcdef"
	if _, err = st.CopyClipboardAssets(ctx, gg, self); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cannot edit source: %v", err)
	}
	if mapping, err := st.CopyClipboardAssets(ctx, og, self); err != nil || mapping[file.ID] != file.ID {
		t.Fatalf("same document should reuse reference: %v %v", mapping, err)
	}
	manage := RoleManage
	revision := int64(0)
	if err = st.PatchManagedDocGuarded(ctx, og, source.ID, ManagedDocPatch{CopyMinRole: &manage, ExpectedPermissionsRevision: &revision}); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CopyClipboardAssets(ctx, gg, req); !errors.Is(err, ErrCopyProtected) {
		t.Fatalf("copy permission on retry: %v", err)
	}
	view := RoleView
	revision++
	if err = st.PatchManagedDocGuarded(ctx, og, source.ID, ManagedDocPatch{CopyMinRole: &view, DownloadMinRole: &manage, ExpectedPermissionsRevision: &revision}); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CopyClipboardAssets(ctx, gg, req); !errors.Is(err, ErrCopyProtected) {
		t.Fatalf("download permission: %v", err)
	}
	revision++
	if err = st.PatchManagedDocGuarded(ctx, og, source.ID, ManagedDocPatch{DownloadMinRole: &view, ExpectedPermissionsRevision: &revision}); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, target.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CopyClipboardAssets(ctx, gg, req); !errors.Is(err, ErrForbidden) {
		t.Fatalf("target revoked: %v", err)
	}
	if err = st.SetShare(ctx, target.ID, guest.ID, RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err = st.DeleteSession(ctx, gg.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CopyClipboardAssets(ctx, gg, req); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("session revoked: %v", err)
	}
	_, refs, err := st.DeleteFile(ctx, file.ID)
	if err != nil || refs < 1 {
		t.Fatalf("copy should retain blob reference: %d %v", refs, err)
	}
	if _, err = st.GetFile(ctx, first[file.ID]); err != nil {
		t.Fatalf("target reference missing: %v", err)
	}
}

func TestMemoryClipboardAssets(t *testing.T) { checkClipboardAssetStore(t, NewMemory()) }

func TestPostgresClipboardAssets(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_clip_assets_%d", time.Now().UnixNano())}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
		admin.Close()
	}()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	checkClipboardAssetStore(t, &Postgres{Pool: pool})
}
