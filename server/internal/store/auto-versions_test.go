package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type autoVersionTestStore interface {
	versionEntryTestStore
	AutoVersionCandidates(context.Context, int64, int) ([]AutoVersionCandidate, error)
	SaveAutomaticVersion(context.Context, AutoVersionCandidate, []byte) (bool, error)
}

func checkAutoVersions(t *testing.T, st autoVersionTestStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "auto-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := RestoreGuard{UserID: owner.ID, SessionHash: []byte("auto-owner-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	d, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Auto", InitialDocOps("Auto"))
	if err != nil {
		t.Fatal(err)
	}
	candidates, err := st.AutoVersionCandidates(ctx, 0, 100)
	if err != nil || len(candidates) != 1 || candidates[0].DocID != d.ID {
		t.Fatalf("candidates: %+v %v", candidates, err)
	}
	c := candidates[0]
	stale := c
	stale.Head++
	if _, err = st.SaveAutomaticVersion(ctx, stale, []byte("state")); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale head: %v", err)
	}
	stale = c
	stale.Epoch++
	if _, err = st.SaveAutomaticVersion(ctx, stale, []byte("state")); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale epoch: %v", err)
	}
	var wg sync.WaitGroup
	created := make([]bool, 6)
	errs := make([]error, 6)
	for i := range created {
		wg.Add(1)
		go func(i int) { defer wg.Done(); created[i], errs[i] = st.SaveAutomaticVersion(ctx, c, []byte("state")) }(i)
	}
	wg.Wait()
	count := 0
	for i := range created {
		if errs[i] != nil {
			t.Fatalf("concurrent save: %v", errs)
		}
		if created[i] {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("created %d automatic versions", count)
	}
	listed, err := st.ListVersionEntries(ctx, guard, d.ID)
	if err != nil || len(listed) != 1 || listed[0].Label != AutoVersionLabel || listed[0].CreatedBy != 0 {
		t.Fatalf("list: %+v %v", listed, err)
	}
	legacy, err := st.Versions(ctx, d.ID)
	if err != nil || len(legacy) != 1 || legacy[0].Label != AutoVersionLabel || legacy[0].CreatedBy != 0 {
		t.Fatalf("legacy version list: %+v %v", legacy, err)
	}
	state, err := st.VersionState(ctx, d.ID, c.Head)
	if err != nil || !bytes.Equal(state, []byte("state")) {
		t.Fatalf("saved state: %v", err)
	}
	candidates, err = st.AutoVersionCandidates(ctx, 0, 100)
	if err != nil || len(candidates) != 0 {
		t.Fatalf("already saved: %+v %v", candidates, err)
	}

	// A manual save at the same head wins without its label being changed.
	manual, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Manual", InitialDocOps("Manual"))
	if err != nil {
		t.Fatal(err)
	}
	epoch, head, err := st.HeadVersion(ctx, manual.ID)
	if err != nil {
		t.Fatal(err)
	}
	version, err := st.CreateVersionEntry(ctx, guard, manual.ID, epoch, head, []byte("manual"), "方案初稿", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	saved, err := st.SaveAutomaticVersion(ctx, AutoVersionCandidate{DocID: manual.ID, Epoch: epoch, Head: head}, []byte("manual"))
	if err != nil || saved {
		t.Fatalf("manual overwritten: %v %v", saved, err)
	}
	listed, err = st.ListVersionEntries(ctx, guard, manual.ID)
	if err != nil || len(listed) != 1 || listed[0].ID != version.ID || listed[0].Label != "方案初稿" {
		t.Fatalf("manual list: %+v %v", listed, err)
	}

	// A new manual name remains possible on a snapshot first created automatically.
	named, err := st.CreateVersionEntry(ctx, guard, d.ID, c.Epoch, c.Head, []byte("state"), "审阅基线", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	if err != nil {
		t.Fatal(err)
	}
	listed, err = st.ListVersionEntries(ctx, guard, d.ID)
	if err != nil || len(listed) != 2 || listed[0].ID == listed[1].ID || (named.ID != listed[0].ID && named.ID != listed[1].ID) {
		t.Fatalf("automatic + named: %+v %v", listed, err)
	}
	// Concurrent automatic and manual saves of the same state retain the named version.
	raceDoc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Race", InitialDocOps("Race"))
	if err != nil {
		t.Fatal(err)
	}
	raceEpoch, raceHead, err := st.HeadVersion(ctx, raceDoc.ID)
	if err != nil {
		t.Fatal(err)
	}
	raceCandidate := AutoVersionCandidate{DocID: raceDoc.ID, Epoch: raceEpoch, Head: raceHead}
	var automaticErr, manualErr error
	var raceGroup sync.WaitGroup
	raceGroup.Add(2)
	go func() {
		defer raceGroup.Done()
		_, automaticErr = st.SaveAutomaticVersion(ctx, raceCandidate, []byte("race"))
	}()
	go func() {
		defer raceGroup.Done()
		_, manualErr = st.CreateVersionEntry(ctx, guard, raceDoc.ID, raceEpoch, raceHead, []byte("race"), "手动版本", "cccccccccccccccccccccccccccccccc")
	}()
	raceGroup.Wait()
	if automaticErr != nil || manualErr != nil {
		t.Fatalf("automatic/manual race: %v %v", automaticErr, manualErr)
	}
	raceVersions, err := st.ListVersionEntries(ctx, guard, raceDoc.ID)
	if err != nil {
		t.Fatal(err)
	}
	manualCount, autoCount := 0, 0
	for _, entry := range raceVersions {
		if entry.Label == "手动版本" {
			manualCount++
		}
		if entry.Label == AutoVersionLabel {
			autoCount++
		}
	}
	if manualCount != 1 || autoCount > 1 || len(raceVersions) != manualCount+autoCount {
		t.Fatalf("race versions: %+v", raceVersions)
	}

	mismatch, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Mismatch", InitialDocOps("Mismatch"))
	if err != nil {
		t.Fatal(err)
	}
	mismatchEpoch, mismatchHead, err := st.HeadVersion(ctx, mismatch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SaveSnapshot(ctx, mismatch.ID, mismatchHead, []byte("original")); err != nil {
		t.Fatal(err)
	}
	if _, err = st.SaveAutomaticVersion(ctx, AutoVersionCandidate{DocID: mismatch.ID, Epoch: mismatchEpoch, Head: mismatchHead}, []byte("different")); !errors.Is(err, ErrConflict) {
		t.Fatalf("different snapshot: %v", err)
	}
	if versions, err := st.Versions(ctx, mismatch.ID); err != nil || len(versions) != 0 {
		t.Fatalf("mismatched snapshot published: %+v %v", versions, err)
	}

	if err = st.BumpHistoryEpoch(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = st.SaveAutomaticVersion(ctx, c, []byte("state")); !errors.Is(err, ErrConflict) {
		t.Fatalf("old epoch: %v", err)
	}
}

func TestMemoryAutoVersions(t *testing.T) { checkAutoVersions(t, NewMemory()) }
func TestPostgresAutoVersions(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{fmt.Sprintf("jiange_auto_versions_%d", time.Now().UnixNano())}.Sanitize()
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
	checkAutoVersions(t, &Postgres{Pool: pool})
}

func TestMemoryAutoVersionCandidatePagination(t *testing.T) {
	ctx := context.Background()
	st := NewMemory()
	owner, ws, err := st.CreateUser(ctx, "auto-pages@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 105; i++ {
		if _, err = st.CreateDoc(ctx, ws.ID, owner.ID, nil, "page", InitialDocOps("page")); err != nil {
			t.Fatal(err)
		}
	}
	first, err := st.AutoVersionCandidates(ctx, 0, 100)
	if err != nil || len(first) != 100 {
		t.Fatalf("first page: %d %v", len(first), err)
	}
	second, err := st.AutoVersionCandidates(ctx, first[len(first)-1].DocID, 100)
	if err != nil || len(second) != 5 || second[0].DocID <= first[len(first)-1].DocID {
		t.Fatalf("second page: %+v %v", second, err)
	}
}
