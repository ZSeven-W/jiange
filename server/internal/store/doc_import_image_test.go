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

type importImageTestStore interface {
	Store
	CreateDocImportImage(context.Context, RestoreGuard, int64, FileMeta) (FileMeta, error)
}

func checkDocImportImageStore(t *testing.T, st importImageTestStore) {
	t.Helper()
	ctx := context.Background()
	u, ws, err := st.CreateUser(ctx, "doc-import-store@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := RestoreGuard{UserID: u.ID, SessionHash: []byte("doc-import-store-session")}
	if err = st.CreateSession(ctx, g.SessionHash, u.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "doc", "文档", true)
	if err != nil {
		t.Fatal(err)
	}
	slides, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "演示", true)
	if err != nil {
		t.Fatal(err)
	}
	file := FileMeta{Name: "word-image.png", Mime: "image/png", Size: 10, ObjectKey: "doc-import-test"}
	other, _, err := st.CreateUser(ctx, "doc-import-other@test.dev", "Other", "hash")
	if err != nil {
		t.Fatal(err)
	}
	otherGuard := RestoreGuard{UserID: other.ID, SessionHash: []byte("doc-import-other-session")}
	if err = st.CreateSession(ctx, otherGuard.SessionHash, other.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CreateDocImportImage(ctx, otherGuard, doc.ID, file); !errors.Is(err, ErrForbidden) {
		t.Fatalf("foreign document: %v", err)
	}
	if _, err = st.CreateDocImportImage(ctx, g, slides.ID, file); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong kind: %v", err)
	}
	bad := file
	bad.Mime = "text/html"
	if _, err = st.CreateDocImportImage(ctx, g, doc.ID, bad); !errors.Is(err, ErrConflict) {
		t.Fatalf("wrong MIME: %v", err)
	}
	created, err := st.CreateDocImportImage(ctx, g, doc.ID, file)
	if err != nil || created.DocID != doc.ID || created.UploaderID != u.ID {
		t.Fatalf("valid upload: %+v %v", created, err)
	}
	if err = st.DeleteSession(ctx, g.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err = st.CreateDocImportImage(ctx, g, doc.ID, file); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("revoked session: %v", err)
	}
}

func TestMemoryDocImportImage(t *testing.T) { checkDocImportImageStore(t, NewMemory()) }

func TestPostgresDocImportImage(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_doc_import_%d", time.Now().UnixNano())}.Sanitize()
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
	checkDocImportImageStore(t, &Postgres{Pool: pool})
}
