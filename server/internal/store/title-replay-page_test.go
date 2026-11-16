package store_test

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type titleReplayStore interface {
	store.Store
	store.TitleReplayPageReader
}

type fakeTitleReplayReader func(context.Context, store.RestoreGuard, int64, int64, int64, int64, int, int) ([]collab.TitleProjectionRecord, error)

func (f fakeTitleReplayReader) ReadTitleReplayPage(ctx context.Context, guard store.RestoreGuard, doc, epoch, head, after int64, rows, bytes int) ([]collab.TitleProjectionRecord, error) {
	return f(ctx, guard, doc, epoch, head, after, rows, bytes)
}

func TestTitleReplayBuilderFailsClosedOnBadPageOrFinalAuthorization(t *testing.T) {
	op := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 0, Clock: 1}, Parent: collab.Root, Pos: "U", Type: "title"}
	raw, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	record := collab.TitleProjectionRecord{DocumentID: 42, Epoch: 3, Seq: 1, ClientID: 0, Clock: 1, Bytes: raw}
	guard := store.RestoreGuard{UserID: 1}
	noProgress := fakeTitleReplayReader(func(context.Context, store.RestoreGuard, int64, int64, int64, int64, int, int) ([]collab.TitleProjectionRecord, error) {
		return nil, nil
	})
	if candidate, err := store.BuildTitleReplayCandidate(context.Background(), noProgress, guard, 42, 3, 1, 1, 1024); !errors.Is(err, store.ErrConflict) || candidate.Visible {
		t.Fatalf("empty page: %+v %v", candidate, err)
	}
	deniedAtEnd := fakeTitleReplayReader(func(_ context.Context, _ store.RestoreGuard, _, _, _, after int64, _, _ int) ([]collab.TitleProjectionRecord, error) {
		if after == 0 {
			return []collab.TitleProjectionRecord{record}, nil
		}
		return nil, store.ErrForbidden
	})
	if candidate, err := store.BuildTitleReplayCandidate(context.Background(), deniedAtEnd, guard, 42, 3, 1, 1, 1024); !errors.Is(err, store.ErrForbidden) || candidate.Visible {
		t.Fatalf("final auth: %+v %v", candidate, err)
	}
	duplicate := fakeTitleReplayReader(func(_ context.Context, _ store.RestoreGuard, _, _, _, after int64, _, _ int) ([]collab.TitleProjectionRecord, error) {
		copy := record
		copy.Seq = uint64(after + 1)
		return []collab.TitleProjectionRecord{copy}, nil
	})
	if candidate, err := store.BuildTitleReplayCandidate(context.Background(), duplicate, guard, 42, 3, 2, 1, 1024); !errors.Is(err, collab.ErrTitleReplayIdentity) || candidate.Visible {
		t.Fatalf("duplicate identity: %+v %v", candidate, err)
	}
	finalChecks := 0
	deniedAfterCausality := fakeTitleReplayReader(func(_ context.Context, _ store.RestoreGuard, _, _, _, after int64, _, _ int) ([]collab.TitleProjectionRecord, error) {
		if after == 0 {
			return []collab.TitleProjectionRecord{record}, nil
		}
		finalChecks++
		if finalChecks == 1 {
			return nil, nil
		}
		return nil, store.ErrForbidden
	})
	if candidate, err := store.BuildCausallyCheckedTitleReplayCandidate(context.Background(), deniedAfterCausality, guard, 42, 3, 1, 1, 1024); !errors.Is(err, store.ErrForbidden) || candidate.Visible {
		t.Fatalf("post-validation auth: %+v %v", candidate, err)
	}
}

func checkTitleReplayPages(t *testing.T, st titleReplayStore) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "title-replay-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "title-replay-editor@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "目录名称", store.InitialDocOps("标题😀"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	guard := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("title-replay-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, editor.ID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	epoch, target, err := st.HeadVersion(ctx, doc.ID)
	if err != nil || target != 3 {
		t.Fatalf("head: %d %d %v", epoch, target, err)
	}
	materialized := collab.NewDoc()
	for _, initial := range store.InitialDocOps("标题😀") {
		ops, e := collab.DecodeOps(initial.Bytes)
		if e != nil || len(ops) != 1 || !materialized.Apply(ops[0]) {
			t.Fatalf("initial snapshot operation: %v", e)
		}
	}
	if err = st.SaveSnapshot(ctx, doc.ID, target, materialized.EncodeState()); err != nil {
		t.Fatal(err)
	}
	if page, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, 0, 1, 1); !errors.Is(err, store.ErrTitleReplayPageLimit) || len(page) != 0 {
		t.Fatalf("small budget: %d %v", len(page), err)
	}
	if page, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, target+1, 1, 1024); !errors.Is(err, store.ErrConflict) || len(page) != 0 {
		t.Fatalf("invalid cursor: %d %v", len(page), err)
	}
	first, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, 0, 1, 1024)
	if err != nil || len(first) != 1 || first[0].Seq != 1 {
		t.Fatalf("first page: %+v %v", first, err)
	}
	original := first[0].Bytes[0]
	first[0].Bytes[0] ^= 0xff
	again, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, 0, 1, 1024)
	if err != nil || len(again) != 1 || again[0].Bytes[0] != original {
		t.Fatalf("page leaked backing bytes: %+v %v", again, err)
	}
	second, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, 1, 1, 1024)
	if err != nil || len(second) != 1 {
		t.Fatalf("second page: %+v %v", second, err)
	}
	budget := len(again[0].Bytes) + len(second[0].Bytes) - 1
	partial, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, 0, 3, budget)
	if err != nil || len(partial) != 1 || partial[0].Seq != 1 {
		t.Fatalf("byte-limited page: %+v %v", partial, err)
	}
	if page, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, 1, 3, len(second[0].Bytes)-1); !errors.Is(err, store.ErrTitleReplayPageLimit) || len(page) != 0 {
		t.Fatalf("next row too large: %+v %v", page, err)
	}
	// A later append does not silently extend the original fixed-head replay.
	newOp := collab.Op{T: collab.TBlockCreate, ID: collab.OpID{Client: 91, Clock: 1}, Parent: collab.Root, Pos: "Z", Type: "paragraph"}
	raw, err := collab.EncodeOps([]collab.Op{newOp})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: 91, Clock: 1, Bytes: raw}}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := st.ReadTitleSnapshot(ctx, doc.ID)
	if err != nil || snapshot.Head != target+1 || snapshot.SnapshotSeq != target {
		t.Fatalf("snapshot with tail: %+v %v", snapshot, err)
	}
	verified, err := store.VerifyTitleSnapshotReplay(ctx, st, guard, doc.ID, epoch, snapshot, 1, 1024)
	if err != nil || verified.Head != uint64(target+1) || verified.Text != "标题😀" || !verified.Visible {
		t.Fatalf("verified snapshot: %+v %v", verified, err)
	}
	badSnapshot := snapshot
	badSnapshot.Snapshot = append([]byte(nil), snapshot.Snapshot...)
	badSnapshot.Snapshot[len(badSnapshot.Snapshot)-1] ^= 1
	if _, err = store.VerifyTitleSnapshotReplay(ctx, st, guard, doc.ID, epoch, badSnapshot, 1, 1024); !errors.Is(err, store.ErrTitleSnapshotUnverified) {
		t.Fatalf("tampered snapshot: %v", err)
	}
	replay, err := collab.NewTitleIdentityReplay(uint64(doc.ID), uint64(epoch))
	if err != nil {
		t.Fatal(err)
	}
	var cursor int64
	for cursor < target {
		page, e := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, cursor, 1, 1024)
		if e != nil || len(page) != 1 {
			t.Fatalf("page at %d: %+v %v", cursor, page, e)
		}
		if e = replay.ApplyRecord(page[0]); e != nil {
			t.Fatal(e)
		}
		cursor = int64(page[0].Seq)
	}
	result, err := replay.CandidateAt(uint64(target))
	if err != nil || !result.Visible || result.Kind != "title" || result.Text != "标题😀" {
		t.Fatalf("candidate: %+v %v", result, err)
	}
	if page, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, target, 1, 1024); err != nil || len(page) != 0 {
		t.Fatalf("end page: %+v %v", page, err)
	}
	if _, err := replay.CandidateAt(uint64(target + 1)); !errors.Is(err, collab.ErrTitleProjectionOrder) {
		t.Fatalf("unread head: %v", err)
	}
	built, err := store.BuildTitleReplayCandidate(ctx, st, guard, doc.ID, epoch, target, 1, 1024)
	if err != nil || built.Head != uint64(target) || built.Text != "标题😀" || !built.Visible {
		t.Fatalf("built candidate: %+v %v", built, err)
	}
	checked, err := store.BuildCausallyCheckedTitleReplayCandidate(ctx, st, guard, doc.ID, epoch, target, 1, 1024)
	if err != nil || checked.Head != uint64(target) || checked.Text != "标题😀" || !checked.Visible {
		t.Fatalf("causal candidate: %+v %v", checked, err)
	}
	// A body-only unresolved operation must prevent the stricter candidate,
	// even though title projection and identity checks alone can still pass.
	orphan := collab.Op{T: collab.TTextInsert, ID: collab.OpID{Client: 92, Clock: 1}, Block: collab.OpID{Client: 93, Clock: 1}, Parent: collab.Root, Side: 1, Text: "孤儿"}
	orphanRaw, err := collab.EncodeOps([]collab.Op{orphan})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: 92, Clock: 1, Bytes: orphanRaw}}); err != nil {
		t.Fatal(err)
	}
	_, currentHead, err := st.HeadVersion(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if candidate, err := store.BuildCausallyCheckedTitleReplayCandidate(ctx, st, guard, doc.ID, epoch, currentHead, 1, 1024); !errors.Is(err, collab.ErrTitleReplayCausality) || candidate.Visible {
		t.Fatalf("body orphan: %+v %v", candidate, err)
	}

	// A session expiring while the page is built must not receive its bytes.
	calls := 0
	expiring := guard
	expiring.Now = func() time.Time {
		calls++
		if calls == 1 {
			return now
		}
		return now.Add(2 * time.Hour)
	}
	if page, err := st.ReadTitleReplayPage(ctx, expiring, doc.ID, epoch, target, 0, 1, 1024); !errors.Is(err, store.ErrUnauthenticated) || len(page) != 0 {
		t.Fatalf("expired session: %d %v", len(page), err)
	}
	calls = 0
	if candidate, err := store.BuildTitleReplayCandidate(ctx, st, expiring, doc.ID, epoch, target, 1, 1024); !errors.Is(err, store.ErrUnauthenticated) || candidate.Text != "" {
		t.Fatalf("expired replay: %+v %v", candidate, err)
	}
	// Hold the page just before its final session check. Revocation must wait
	// for that authorized read to finish, then the next page must be denied.
	locked, release, started := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var reads atomic.Int32
	blocking := guard
	blocking.Now = func() time.Time {
		if reads.Add(1) == 2 {
			close(locked)
			<-release
		}
		return now
	}
	readResult := make(chan error, 1)
	go func() {
		_, e := st.ReadTitleReplayPage(ctx, blocking, doc.ID, epoch, target, 0, 1, 1024)
		readResult <- e
	}()
	select {
	case <-locked:
	case <-time.After(3 * time.Second):
		t.Fatal("read did not reach final guard")
	}
	revoked := make(chan error, 1)
	go func() { close(started); revoked <- st.SetShare(ctx, doc.ID, editor.ID, "") }()
	<-started
	select {
	case e := <-revoked:
		t.Fatalf("revocation raced through an authorized read: %v", e)
	case <-time.After(100 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case e := <-readResult:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("read did not finish")
	}
	select {
	case e := <-revoked:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("revocation did not finish")
	}
	if page, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, 0, 1, 1024); !errors.Is(err, store.ErrForbidden) || len(page) != 0 {
		t.Fatalf("revoked read: %d %v", len(page), err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if page, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, 0, 1, 1024); !errors.Is(err, store.ErrForbidden) || len(page) != 0 {
		t.Fatalf("view-only: %d %v", len(page), err)
	}
	if err = st.SetShare(ctx, doc.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err = st.BumpHistoryEpoch(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if page, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, 0, 1, 1024); !errors.Is(err, store.ErrConflict) || len(page) != 0 {
		t.Fatalf("old epoch: %d %v", len(page), err)
	}
	if err = st.DeleteSession(ctx, guard.SessionHash); err != nil {
		t.Fatal(err)
	}
	if page, err := st.ReadTitleReplayPage(ctx, guard, doc.ID, epoch, target, 0, 1, 1024); !errors.Is(err, store.ErrUnauthenticated) || len(page) != 0 {
		t.Fatalf("logged out: %d %v", len(page), err)
	}
}

func TestMemoryTitleReplayPages(t *testing.T) { checkTitleReplayPages(t, store.NewMemory()) }

func TestPostgresTitleReplayPages(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	pg, err := store.NewPostgres(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err = migrate.Up(context.Background(), pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkTitleReplayPages(t, pg)
}

func TestPostgresTitleReplayRejectsDamagedRowsAndGaps(t *testing.T) {
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
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	owner, ws, err := pg.CreateUser(ctx, "title-replay-corrupt@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("title-replay-corrupt-session")}
	if err = pg.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	newDoc := func(name string) store.DocMeta {
		doc, e := pg.CreateDoc(ctx, ws.ID, owner.ID, nil, name, store.InitialDocOps(name))
		if e != nil {
			t.Fatal(e)
		}
		return doc
	}
	damaged := newDoc("damaged")
	epoch, head, err := pg.HeadVersion(ctx, damaged.ID)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pg.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE doc_ops SET clock=-1 WHERE doc_id=$1 AND seq=1`, damaged.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE doc_op_ranges SET clock=-1 WHERE doc_id=$1 AND seq=1`, damaged.ID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if page, err := pg.ReadTitleReplayPage(ctx, guard, damaged.ID, epoch, head, 0, 5, 4096); !errors.Is(err, store.ErrConflict) || len(page) != 0 {
		t.Fatalf("negative clock: %+v %v", page, err)
	}
	gap := newDoc("gap")
	epoch, head, err = pg.HeadVersion(ctx, gap.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pg.Pool.Exec(ctx, `DELETE FROM doc_ops WHERE doc_id=$1 AND seq=2`, gap.ID); err != nil {
		t.Fatal(err)
	}
	if page, err := pg.ReadTitleReplayPage(ctx, guard, gap.ID, epoch, head, 0, 5, 4096); !errors.Is(err, store.ErrConflict) || len(page) != 0 {
		t.Fatalf("gap leaked prefix: %+v %v", page, err)
	}
}
