package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type autoSweepTestStore interface {
	store.Store
	AutomaticVersionStore
	ListVersionEntries(context.Context, store.RestoreGuard, int64) ([]store.VersionEntry, error)
}

func checkAutomaticVersionSweep(t *testing.T, st autoSweepTestStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "auto-sweep@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("auto-sweep-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Doc", store.InitialDocOps("Doc"))
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Store: st}
	seedDoc(t, s, doc.ID, "第一版")
	// A periodic sync snapshot may already exist at the same sequence.
	current, head, err := StateAtHead(ctx, st, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SaveSnapshot(ctx, doc.ID, head, current.EncodeState()); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))
	n, err := SweepAutomaticVersions(ctx, st, log)
	if err != nil || n != 1 {
		t.Fatalf("first sweep %d %v %s", n, err, logs.String())
	}
	versions, err := st.ListVersionEntries(ctx, guard, doc.ID)
	if err != nil || len(versions) != 1 || versions[0].Label != store.AutoVersionLabel {
		t.Fatalf("versions %+v %v", versions, err)
	}
	snapshot, err := st.VersionState(ctx, doc.ID, versions[0].Seq)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := collab.DecodeState(snapshot)
	if err != nil || !strings.Contains(viewText(decoded.View()), "第一版") {
		t.Fatalf("snapshot %v", err)
	}
	if n, err = SweepAutomaticVersions(ctx, st, log); err != nil || n != 0 {
		t.Fatalf("repeat %d %v", n, err)
	}
	seedDoc(t, s, doc.ID, "第二版")
	if n, err = SweepAutomaticVersions(ctx, st, log); err != nil || n != 1 {
		t.Fatalf("second sweep %d %v", n, err)
	}
	versions, err = st.ListVersionEntries(ctx, guard, doc.ID)
	if err != nil || len(versions) != 2 || versions[0].Seq == versions[1].Seq {
		t.Fatalf("new head %+v %v", versions, err)
	}
}

func TestAutomaticVersionSweep(t *testing.T) { checkAutomaticVersionSweep(t, store.NewMemory()) }

func TestPostgresAutomaticVersionSweep(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_auto_sweep_%d", time.Now().UnixNano())}.Sanitize()
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
	checkAutomaticVersionSweep(t, &store.Postgres{Pool: pool})
}

type failOnceAutoStore struct {
	*store.Memory
	failDoc int64
	failed  bool
}

func (s *failOnceAutoStore) SaveAutomaticVersion(ctx context.Context, candidate store.AutoVersionCandidate, state []byte) (bool, error) {
	if candidate.DocID == s.failDoc && !s.failed {
		s.failed = true
		return false, errors.New("temporary failure")
	}
	return s.Memory.SaveAutomaticVersion(ctx, candidate, state)
}

func TestAutomaticVersionSweepRetriesMissedDocuments(t *testing.T) {
	ctx := context.Background()
	st := &failOnceAutoStore{Memory: store.NewMemory()}
	owner, ws, err := st.CreateUser(ctx, "auto-retry@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "first", store.InitialDocOps("first"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "second", store.InitialDocOps("second"))
	if err != nil {
		t.Fatal(err)
	}
	st.failDoc = first.ID
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))
	if n, err := SweepAutomaticVersions(ctx, st, log); err != nil || n != 1 {
		t.Fatalf("first sweep: %d %v", n, err)
	}
	if _, err := st.Versions(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	versions, err := st.Versions(ctx, second.ID)
	if err != nil || len(versions) != 1 {
		t.Fatalf("other document: %+v %v", versions, err)
	}
	if n, err := SweepAutomaticVersions(ctx, st, log); err != nil || n != 1 {
		t.Fatalf("retry sweep: %d %v", n, err)
	}
	versions, err = st.Versions(ctx, first.ID)
	if err != nil || len(versions) != 1 {
		t.Fatalf("retry document: %+v %v", versions, err)
	}
}
