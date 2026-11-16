package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkGuardedRecordLinks(t *testing.T, st Store) {
	t.Helper()
	ctx := context.Background()
	source, owner, guard, _ := baseGuardFixture(t, st)
	workspaces, err := st.Workspaces(ctx, owner.ID)
	if err != nil || len(workspaces) == 0 {
		t.Fatalf("workspaces=%v err=%v", workspaces, err)
	}
	target, err := st.CreateInitializedBase(ctx, workspaces[0].ID, owner.ID, nil, "target")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, target.ID, guard.UserID, RoleEdit); err != nil {
		t.Fatal(err)
	}
	from, err := st.AddField(ctx, Field{BaseID: source.ID, Name: "from", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	back, err := st.AddField(ctx, Field{BaseID: target.ID, Name: "back", Type: "link", Options: []string{strconv.FormatInt(source.ID, 10), strconv.FormatInt(from.ID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	from.Options = []string{strconv.FormatInt(target.ID, 10), strconv.FormatInt(back.ID, 10)}
	if _, err := st.UpdateField(ctx, from); err != nil {
		t.Fatal(err)
	}
	sourceRows, err := st.Records(ctx, source.ID)
	if err != nil || len(sourceRows) == 0 {
		t.Fatalf("source=%v err=%v", sourceRows, err)
	}
	targetRows, err := st.Records(ctx, target.ID)
	if err != nil || len(targetRows) == 0 {
		t.Fatalf("target=%v err=%v", targetRows, err)
	}
	rid, tid := sourceRows[0].ID, targetRows[0].ID
	key := strconv.FormatInt(from.ID, 10)
	value, _ := json.Marshal([]int64{tid})
	mutation := BaseRecordMutation{Operation: "update", RecordID: rid, Cells: map[string]json.RawMessage{key: value}}
	validate := func([]Field) error { return nil }
	rec, affected, err := st.MutateRecordGuarded(ctx, guard, source.ID, mutation, validate)
	if err != nil || rec.ID != rid || len(affected) != 2 {
		t.Fatalf("link update: rec=%+v affected=%v err=%v", rec, affected, err)
	}
	forward, err := st.LinksForRecords(ctx, from.ID, []int64{rid})
	if err != nil || len(forward[rid]) != 1 || forward[rid][0] != tid {
		t.Fatalf("forward=%v err=%v", forward, err)
	}
	reverse, err := st.LinksForRecords(ctx, back.ID, []int64{tid})
	if err != nil || len(reverse[tid]) != 1 || reverse[tid][0] != rid {
		t.Fatalf("reverse=%v err=%v", reverse, err)
	}
	sourceHead, _ := st.BtHead(ctx, source.ID)
	targetHead, _ := st.BtHead(ctx, target.ID)
	if sourceHead == 0 || targetHead == 0 {
		t.Fatalf("missing events %d,%d", sourceHead, targetHead)
	}

	// Concurrent edits from opposite ends lock the two Bases in the same
	// order; neither may deadlock or leave only one reciprocal link.
	reverseValue, _ := json.Marshal([]int64{rid})
	reverseMutation := BaseRecordMutation{Operation: "update", RecordID: tid, Cells: map[string]json.RawMessage{strconv.FormatInt(back.ID, 10): reverseValue}}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, task := range []struct {
		base     int64
		mutation BaseRecordMutation
	}{{source.ID, mutation}, {target.ID, reverseMutation}} {
		wg.Add(1)
		go func(base int64, change BaseRecordMutation) {
			defer wg.Done()
			_, _, e := st.MutateRecordGuarded(ctx, guard, base, change, validate)
			results <- e
		}(task.base, task.mutation)
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatalf("opposite link edit: %v", err)
		}
	}
	forward, _ = st.LinksForRecords(ctx, from.ID, []int64{rid})
	reverse, _ = st.LinksForRecords(ctx, back.ID, []int64{tid})
	if len(forward[rid]) != 1 || len(reverse[tid]) != 1 {
		t.Fatalf("concurrent links inconsistent forward=%v reverse=%v", forward, reverse)
	}
	sourceHead, _ = st.BtHead(ctx, source.ID)
	targetHead, _ = st.BtHead(ctx, target.ID)
	// Updating another cell must not strip nulls nested inside an existing
	// JSON value (jsonb_strip_nulls would silently rewrite unrelated data).
	attachment, err := st.AddField(ctx, Field{BaseID: source.ID, Name: "Attachment", Type: "attachment"})
	if err != nil {
		t.Fatal(err)
	}
	attachmentKey := strconv.FormatInt(attachment.ID, 10)
	nested, err := st.AddRecord(ctx, Record{BaseID: source.ID, Cells: map[string]json.RawMessage{attachmentKey: json.RawMessage(`[{"id":1,"name":"x","extra":null}]`)}})
	if err != nil {
		t.Fatal(err)
	}
	textFields, err := st.Fields(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	textKey := strconv.FormatInt(textFields[0].ID, 10)
	if _, _, err := st.MutateRecordGuarded(ctx, guard, source.ID, BaseRecordMutation{Operation: "update", RecordID: nested.ID, Cells: map[string]json.RawMessage{textKey: json.RawMessage(`"hello"`)}}, validate); err != nil {
		t.Fatal(err)
	}
	rows, err := st.Records(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	var attachments []map[string]any
	var nestedRaw json.RawMessage
	for _, row := range rows {
		if row.ID == nested.ID {
			nestedRaw = row.Cells[attachmentKey]
			break
		}
	}
	if err := json.Unmarshal(nestedRaw, &attachments); err != nil || len(attachments) != 1 {
		t.Fatalf("attachment=%s err=%v", nestedRaw, err)
	}
	if value, ok := attachments[0]["extra"]; !ok || value != nil {
		t.Fatalf("nested null removed: %v", attachments)
	}
	sourceHead, _ = st.BtHead(ctx, source.ID)

	// Revocation must leave both cached cells and reciprocal links untouched.
	if err := st.SetShare(ctx, target.ID, guard.UserID, ""); err != nil {
		t.Fatal(err)
	}
	mutation.Cells[key] = json.RawMessage(`[]`)
	if _, _, err := st.MutateRecordGuarded(ctx, guard, source.ID, mutation, validate); !errors.Is(err, ErrForbidden) {
		t.Fatalf("target revoked: %v", err)
	}
	forward, _ = st.LinksForRecords(ctx, from.ID, []int64{rid})
	reverse, _ = st.LinksForRecords(ctx, back.ID, []int64{tid})
	if len(forward[rid]) != 1 || len(reverse[tid]) != 1 {
		t.Fatalf("partial links forward=%v reverse=%v", forward, reverse)
	}
	if h, _ := st.BtHead(ctx, source.ID); h != sourceHead {
		t.Fatalf("rejected write emitted event %d -> %d", sourceHead, h)
	}
	if err := st.SetShare(ctx, target.ID, guard.UserID, RoleEdit); err != nil {
		t.Fatal(err)
	}

	// A forged companion reference must not alter an unrelated link field.
	from.Options = []string{strconv.FormatInt(target.ID, 10), strconv.FormatInt(back.ID+12345, 10)}
	if _, err := st.UpdateField(ctx, from); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.MutateRecordGuarded(ctx, guard, source.ID, mutation, validate); !errors.Is(err, ErrConflict) {
		t.Fatalf("bad companion: %v", err)
	}
	from.Options = []string{strconv.FormatInt(target.ID, 10), strconv.FormatInt(back.ID, 10)}
	if _, err := st.UpdateField(ctx, from); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.MutateRecordGuarded(ctx, guard, source.ID, BaseRecordMutation{Operation: "delete", RecordID: rid}, validate); err != nil {
		t.Fatal(err)
	}
	forward, _ = st.LinksForRecords(ctx, from.ID, []int64{rid})
	reverse, _ = st.LinksForRecords(ctx, back.ID, []int64{tid})
	if len(forward[rid]) != 0 || len(reverse[tid]) != 0 {
		t.Fatalf("delete left dangling links forward=%v reverse=%v", forward, reverse)
	}
	if h, _ := st.BtHead(ctx, target.ID); h <= targetHead {
		t.Fatalf("target did not receive reload event: %d -> %d", targetHead, h)
	}
}

func TestMemoryGuardedRecordLinks(t *testing.T) { checkGuardedRecordLinks(t, NewMemory()) }

func TestMemoryRecordIndexSurvivesLegacyDeletion(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	base, _, guard, _ := baseGuardFixture(t, m)
	rows, err := m.Records(ctx, base.ID)
	if err != nil || len(rows) < 3 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	fields, err := m.Fields(ctx, base.ID)
	if err != nil || len(fields) == 0 {
		t.Fatal(err)
	}
	key := strconv.FormatInt(fields[0].ID, 10)
	last := rows[2].ID
	change := BaseRecordMutation{Operation: "update", RecordID: last, Cells: map[string]json.RawMessage{key: json.RawMessage(`"before"`)}}
	if _, _, err := m.MutateRecordGuarded(ctx, guard, base.ID, change, func([]Field) error { return nil }); err != nil {
		t.Fatal(err)
	}
	// Legacy/public paths can still delete directly, shifting every slice index.
	if err := m.DeleteRecord(ctx, base.ID, rows[0].ID); err != nil {
		t.Fatal(err)
	}
	change.Cells[key] = json.RawMessage(`"after"`)
	if got, _, err := m.MutateRecordGuarded(ctx, guard, base.ID, change, func([]Field) error { return nil }); err != nil || got.ID != last {
		t.Fatalf("wrong record %+v err=%v", got, err)
	}
	current, _ := m.Records(ctx, base.ID)
	for _, r := range current {
		if r.ID == last && string(r.Cells[key]) != `"after"` {
			t.Fatalf("record not updated: %+v", r)
		}
		if r.ID != last && len(r.Cells[key]) != 0 {
			t.Fatalf("another record changed: %+v", r)
		}
	}
}

func BenchmarkMemoryGuardedOrdinaryWrite(b *testing.B) {
	for _, n := range []int{0, 100000} {
		b.Run(fmt.Sprintf("unrelated_links_%d", n), func(b *testing.B) {
			ctx := context.Background()
			m := NewMemory()
			owner, ws, err := m.CreateUser(ctx, "bench@example.test", "Owner", "hash")
			if err != nil {
				b.Fatal(err)
			}
			base, err := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "base")
			if err != nil {
				b.Fatal(err)
			}
			fields, _ := m.Fields(ctx, base.ID)
			rows, _ := m.Records(ctx, base.ID)
			guard := BaseWriteGuard{UserID: owner.ID, SessionHash: []byte("bench")}
			if err := m.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
				b.Fatal(err)
			}
			m.mu.Lock()
			m.links = make(map[[2]int64][]int64, n)
			for i := 0; i < n; i++ {
				m.links[[2]int64{int64(100000 + i), int64(200000 + i)}] = []int64{int64(i)}
			}
			m.mu.Unlock()
			change := BaseRecordMutation{Operation: "update", RecordID: rows[0].ID, Cells: map[string]json.RawMessage{strconv.FormatInt(fields[0].ID, 10): json.RawMessage(`"value"`)}}
			if _, _, err := m.MutateRecordGuarded(ctx, guard, base.ID, change, func([]Field) error { return nil }); err != nil {
				b.Fatal(err)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, _, err := m.MutateRecordGuarded(ctx, guard, base.ID, change, func([]Field) error { return nil }); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func TestPostgresGuardedRecordLinks(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_record_guard_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
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
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := &Postgres{Pool: pool}
	checkGuardedRecordLinks(t, s)
	owner, ws, err := s.CreateUser(ctx, "record-rollback@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "source")
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "target")
	if err != nil {
		t.Fatal(err)
	}
	link, err := s.AddField(ctx, Field{BaseID: source.ID, Name: "Link", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	sourceRows, err := s.Records(ctx, source.ID)
	if err != nil || len(sourceRows) == 0 {
		t.Fatalf("source rows=%v err=%v", sourceRows, err)
	}
	targetRows, err := s.Records(ctx, target.ID)
	if err != nil || len(targetRows) == 0 {
		t.Fatalf("target rows=%v err=%v", targetRows, err)
	}
	guard := BaseWriteGuard{UserID: owner.ID, SessionHash: []byte("record-rollback-session")}
	if err := s.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION fail_record_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected link failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER fail_record_link BEFORE INSERT ON bt_links FOR EACH ROW EXECUTE FUNCTION fail_record_link()`); err != nil {
		t.Fatal(err)
	}
	key := strconv.FormatInt(link.ID, 10)
	value, _ := json.Marshal([]int64{targetRows[0].ID})
	mutation := BaseRecordMutation{Operation: "update", RecordID: sourceRows[0].ID, Cells: map[string]json.RawMessage{key: value}}
	if _, _, err := s.MutateRecordGuarded(ctx, guard, source.ID, mutation, func([]Field) error { return nil }); err == nil {
		t.Fatal("injected link failure committed")
	}
	rows, err := s.Records(ctx, source.ID)
	if err != nil || len(rows[0].Cells[key]) != 0 {
		t.Fatalf("partial record update rows=%v err=%v", rows, err)
	}
	if head, err := s.BtHead(ctx, source.ID); err != nil || head != 0 {
		t.Fatalf("event head=%d err=%v", head, err)
	}

	// Measure the current coarse schema/records/link table lock with writes on
	// independent Bases. This is an informational local baseline, not an SLA.
	type targetRow struct {
		base, record int64
		field        string
	}
	targets := make([]targetRow, 4)
	for i := range targets {
		b, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, fmt.Sprintf("parallel-%d", i))
		if err != nil {
			t.Fatal(err)
		}
		fields, err := s.Fields(ctx, b.ID)
		if err != nil || len(fields) == 0 {
			t.Fatalf("fields=%v err=%v", fields, err)
		}
		rows, err := s.Records(ctx, b.ID)
		if err != nil || len(rows) == 0 {
			t.Fatalf("rows=%v err=%v", rows, err)
		}
		targets[i] = targetRow{b.ID, rows[0].ID, strconv.FormatInt(fields[0].ID, 10)}
	}
	startTime := time.Now()
	var wg sync.WaitGroup
	errCh := make(chan error, 4)
	for _, target := range targets {
		wg.Add(1)
		go func(target targetRow) {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				raw, _ := json.Marshal(fmt.Sprintf("value-%d", i))
				_, _, err := s.MutateRecordGuarded(ctx, guard, target.base, BaseRecordMutation{Operation: "update", RecordID: target.record, Cells: map[string]json.RawMessage{target.field: raw}}, func([]Field) error { return nil })
				if err != nil {
					errCh <- err
					return
				}
			}
		}(target)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatalf("independent Base writes: %v", err)
	}
	t.Logf("100 guarded writes across 4 Bases: %s", time.Since(startTime))
}
