package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func fieldConvertFixture(_ Field, to Field, raw json.RawMessage) json.RawMessage {
	var s string
	if to.Type != "number" || json.Unmarshal(raw, &s) != nil {
		return nil
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	b, _ := json.Marshal(n)
	return b
}

func checkFieldMutation(t *testing.T, st Store) {
	t.Helper()
	ctx := context.Background()
	base, owner, editorGuard, view := baseGuardFixture(t, st)
	ownerGuard := BaseWriteGuard{UserID: owner.ID, SessionHash: []byte("field-owner-session")}
	if err := st.CreateSession(ctx, ownerGuard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	fields, err := st.Fields(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	f := Field{BaseID: base.ID, Name: "amount", Type: "text"}
	created, err := st.MutateFieldGuarded(ctx, editorGuard, FieldMutation{BaseID: base.ID, After: &f, Fields: fields})
	if err != nil || created.Field.ID == 0 {
		t.Fatalf("add=%+v err=%v", created, err)
	}
	key := strconv.FormatInt(created.Field.ID, 10)
	rows, err := st.Records(ctx, base.ID)
	if err != nil || len(rows) < 2 {
		t.Fatal(err)
	}
	rid := rows[0].ID
	if _, err := st.SetCells(ctx, base.ID, rows[0].ID, map[string]json.RawMessage{key: json.RawMessage(`"3.5"`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetCells(ctx, base.ID, rows[1].ID, map[string]json.RawMessage{key: json.RawMessage(`"bad"`)}); err != nil {
		t.Fatal(err)
	}
	fields, _ = st.Fields(ctx, base.ID)
	old := created.Field
	updated := old
	updated.Type = "number"
	result, err := st.MutateFieldGuarded(ctx, editorGuard, FieldMutation{BaseID: base.ID, Before: &old, After: &updated, Fields: fields, Convert: fieldConvertFixture})
	if err != nil || result.Field.Type != "number" {
		t.Fatalf("convert=%+v err=%v", result, err)
	}
	rows, _ = st.Records(ctx, base.ID)
	if string(rows[0].Cells[key]) != "3.5" || len(rows[1].Cells[key]) != 0 {
		t.Fatalf("converted rows=%+v", rows)
	}
	if _, err := st.MutateFieldGuarded(ctx, editorGuard, FieldMutation{BaseID: base.ID, Before: &old, After: &updated, Fields: fields, Convert: fieldConvertFixture}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale schema err=%v", err)
	}

	// A manager may edit a locked view but cannot delete or change the
	// semantics of a referenced field and thereby silently weaken the policy.
	view.Config = json.RawMessage(fmt.Sprintf(`{"locked":true,"filters":{"conj":"and","rules":[{"f":%d,"op":"gt","v":1}]}}`, updated.ID))
	if _, err := st.UpdateView(ctx, view); err != nil {
		t.Fatal(err)
	}
	fields, _ = st.Fields(ctx, base.ID)
	if _, err := st.MutateFieldGuarded(ctx, ownerGuard, FieldMutation{BaseID: base.ID, Before: &updated, Fields: fields}); !errors.Is(err, ErrConflict) {
		t.Fatalf("delete locked field err=%v", err)
	}
	newType := updated
	newType.Type = "text"
	if _, err := st.MutateFieldGuarded(ctx, ownerGuard, FieldMutation{BaseID: base.ID, Before: &updated, After: &newType, Fields: fields, Convert: fieldConvertFixture}); !errors.Is(err, ErrConflict) {
		t.Fatalf("change locked field err=%v", err)
	}
	if _, err := st.MutateFieldGuarded(ctx, editorGuard, FieldMutation{BaseID: base.ID, Before: &updated, Fields: fields}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("locked nonmanager err=%v", err)
	}

	// A field creation may not create its reciprocal field in another base
	// unless the same caller can edit that target in the commit transaction.
	view.Config = json.RawMessage(`{}`)
	if _, err := st.UpdateView(ctx, view); err != nil {
		t.Fatal(err)
	}
	workspaces, err := st.Workspaces(ctx, owner.ID)
	if err != nil || len(workspaces) == 0 {
		t.Fatal(err)
	}
	target, err := st.CreateInitializedBase(ctx, workspaces[0].ID, owner.ID, nil, "target")
	if err != nil {
		t.Fatal(err)
	}
	fields, _ = st.Fields(ctx, base.ID)
	link := Field{BaseID: base.ID, Name: "related", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}}
	if _, err := st.MutateFieldGuarded(ctx, editorGuard, FieldMutation{BaseID: base.ID, After: &link, Fields: fields}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("unshared target err=%v", err)
	}
	if err := st.SetShare(ctx, target.ID, editorGuard.UserID, RoleEdit); err != nil {
		t.Fatal(err)
	}
	pair, err := st.MutateFieldGuarded(ctx, editorGuard, FieldMutation{BaseID: base.ID, After: &link, Fields: fields})
	if err != nil || len(pair.Field.Options) != 2 || len(pair.Notify) != 2 {
		t.Fatalf("pair=%+v err=%v", pair, err)
	}
	targetFields, _ := st.Fields(ctx, target.ID)
	var companion *Field
	for i := range targetFields {
		if strconv.FormatInt(targetFields[i].ID, 10) == pair.Field.Options[1] {
			companion = &targetFields[i]
			break
		}
	}
	if companion == nil || companion.Type != "link" || len(companion.Options) != 2 || companion.Options[0] != strconv.FormatInt(base.ID, 10) || companion.Options[1] != strconv.FormatInt(pair.Field.ID, 10) {
		t.Fatalf("companion=%+v", companion)
	}
	targetRows, err := st.Records(ctx, target.ID)
	if err != nil || len(targetRows) == 0 {
		t.Fatal(err)
	}
	if err := st.SetLinks(ctx, target.ID, companion.ID, targetRows[0].ID, []int64{rid}); err != nil {
		t.Fatal(err)
	}
	// Removing the source detaches the reciprocal back-pointer but preserves
	// the target's field and its data; no dangling reference to a deleted ID.
	fields, _ = st.Fields(ctx, base.ID)
	if _, err := st.MutateFieldGuarded(ctx, editorGuard, FieldMutation{BaseID: base.ID, Before: &pair.Field, Fields: fields}); err != nil {
		t.Fatal(err)
	}
	targetFields, _ = st.Fields(ctx, target.ID)
	companion = nil
	for i := range targetFields {
		if strconv.FormatInt(targetFields[i].ID, 10) == pair.Field.Options[1] {
			companion = &targetFields[i]
			break
		}
	}
	if companion == nil || len(companion.Options) != 1 || companion.Options[0] != strconv.FormatInt(base.ID, 10) {
		t.Fatalf("detached companion=%+v", companion)
	}
	links, err := st.LinksForRecords(ctx, companion.ID, []int64{targetRows[0].ID})
	if err != nil || len(links[targetRows[0].ID]) != 1 || links[targetRows[0].ID][0] != rid {
		t.Fatalf("target link data lost: %v err=%v", links, err)
	}
}

func TestMemoryFieldMutationGuarded(t *testing.T) { checkFieldMutation(t, NewMemory()) }

func TestPostgresFieldMutationGuarded(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_field_guard_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
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
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := &Postgres{Pool: pool}
	checkFieldMutation(t, s)

	// A failure after schema/cell rewrites but before the reload event must
	// leave both the schema and original cell untouched.
	owner, ws, err := s.CreateUser(ctx, "field-rollback@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "rollback")
	if err != nil {
		t.Fatal(err)
	}
	f, err := s.AddField(ctx, Field{BaseID: base.ID, Name: "number", Type: "text"})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := s.Records(ctx, base.ID)
	if err != nil || len(rows) == 0 {
		t.Fatal(err)
	}
	key := strconv.FormatInt(f.ID, 10)
	if _, err := s.SetCells(ctx, base.ID, rows[0].ID, map[string]json.RawMessage{key: json.RawMessage(`"7"`)}); err != nil {
		t.Fatal(err)
	}
	guard := BaseWriteGuard{UserID: owner.ID, SessionHash: []byte("field-rollback-session")}
	if err := s.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	fields, _ := s.Fields(ctx, base.ID)
	if _, err := pool.Exec(ctx, `CREATE FUNCTION fail_field_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected event failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER fail_field_event BEFORE INSERT ON bt_events FOR EACH ROW EXECUTE FUNCTION fail_field_event()`); err != nil {
		t.Fatal(err)
	}
	next := f
	next.Type = "number"
	if _, err := s.MutateFieldGuarded(ctx, guard, FieldMutation{BaseID: base.ID, Before: &f, After: &next, Fields: fields, Convert: fieldConvertFixture}); err == nil {
		t.Fatal("event failure unexpectedly committed")
	}
	after, err := s.Fields(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(fields) || after[len(after)-1].Type != "text" {
		t.Fatalf("partial field update: %+v", after)
	}
	rows, err = s.Records(ctx, base.ID)
	if err != nil || string(rows[0].Cells[key]) != `"7"` {
		t.Fatalf("partial cell conversion: %+v err=%v", rows, err)
	}
	target, err := s.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "target-rollback")
	if err != nil {
		t.Fatal(err)
	}
	targetBefore, err := s.Fields(ctx, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	link := Field{BaseID: base.ID, Name: "关联", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}}
	if _, err := s.MutateFieldGuarded(ctx, guard, FieldMutation{BaseID: base.ID, After: &link, Fields: fields}); err == nil {
		t.Fatal("event failure unexpectedly created paired fields")
	}
	sourceAfter, err := s.Fields(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	targetAfter, err := s.Fields(ctx, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sourceAfter) != len(fields) || len(targetAfter) != len(targetBefore) {
		t.Fatalf("partial pair: source=%+v target=%+v", sourceAfter, targetAfter)
	}

	// The caller's effective share and locked-view state are held through the
	// conversion, so concurrent revocation cannot slip between validation and
	// record publication.
	if _, err := pool.Exec(ctx, `DROP TRIGGER fail_field_event ON bt_events`); err != nil {
		t.Fatal(err)
	}
	editor, _, err := s.CreateUser(ctx, "field-concurrent@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetShare(ctx, base.ID, editor.ID, RoleEdit); err != nil {
		t.Fatal(err)
	}
	concurrentGuard := BaseWriteGuard{UserID: editor.ID, SessionHash: []byte("field-concurrent-session")}
	if err := s.CreateSession(ctx, concurrentGuard.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	fields, err = s.Fields(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	convert := func(before, after Field, raw json.RawMessage) json.RawMessage {
		close(entered)
		<-release
		return fieldConvertFixture(before, after, raw)
	}
	mutationDone := make(chan error, 1)
	go func() {
		_, err := s.MutateFieldGuarded(ctx, concurrentGuard, FieldMutation{BaseID: base.ID, Before: &f, After: &next, Fields: fields, Convert: convert})
		mutationDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("conversion did not reach guarded transaction")
	}
	revokeDone := make(chan error, 1)
	go func() { revokeDone <- s.SetShare(ctx, base.ID, editor.ID, "") }()
	select {
	case err := <-revokeDone:
		close(release)
		t.Fatalf("revocation escaped guarded conversion: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	close(release)
	if err := <-mutationDone; err != nil {
		t.Fatal(err)
	}
	if err := <-revokeDone; err != nil {
		t.Fatal(err)
	}
	fields, err = s.Fields(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.MutateFieldGuarded(ctx, concurrentGuard, FieldMutation{BaseID: base.ID, Before: &next, Fields: fields}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("revoked editor: %v", err)
	}
}
