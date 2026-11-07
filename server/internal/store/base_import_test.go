package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkAtomicBaseImport(t *testing.T, st store.Store) (store.DocMeta, store.BaseWriteGuard) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "csv-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "csv-editor@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Base")
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, base.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	guard := store.BaseWriteGuard{UserID: editor.ID, SessionHash: []byte("csv-test-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, editor.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	build := func(fields []store.Field) (store.BaseImportPlan, error) {
		if len(fields) != 1 {
			return store.BaseImportPlan{}, fmt.Errorf("unexpected fields %d", len(fields))
		}
		return store.BaseImportPlan{
			Columns: []store.ImportColumn{{ExistingID: fields[0].ID}, {New: store.Field{Name: "数值", Type: "number"}}},
			Rows:    []map[int]json.RawMessage{{0: json.RawMessage(`"任务"`), 1: json.RawMessage(`3`)}},
		}, nil
	}
	fields, _ := st.Fields(ctx, base.ID)
	records, _ := st.Records(ctx, base.ID)
	head, _ := st.BtHead(ctx, base.ID)
	if _, err = st.ImportBaseCSV(ctx, guard, base.ID, func([]store.Field) (store.BaseImportPlan, error) {
		return store.BaseImportPlan{}, errors.New("plan failed")
	}); err == nil {
		t.Fatal("builder failure was ignored")
	}
	bad := func([]store.Field) (store.BaseImportPlan, error) {
		return store.BaseImportPlan{Columns: []store.ImportColumn{{New: store.Field{Name: "bad", Type: "text"}}}, Rows: []map[int]json.RawMessage{{1: json.RawMessage(`"out of bounds"`)}}}, nil
	}
	if _, err = st.ImportBaseCSV(ctx, guard, base.ID, bad); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid plan: %v", err)
	}
	expired := guard
	expired.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if _, err = st.ImportBaseCSV(ctx, expired, base.ID, build); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("expired: %v", err)
	}
	if err = st.SetShare(ctx, base.ID, editor.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if _, err = st.ImportBaseCSV(ctx, guard, base.ID, build); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked: %v", err)
	}
	gotFields, _ := st.Fields(ctx, base.ID)
	gotRecords, _ := st.Records(ctx, base.ID)
	gotHead, _ := st.BtHead(ctx, base.ID)
	if len(gotFields) != len(fields) || len(gotRecords) != len(records) || gotHead != head {
		t.Fatal("failed import mutated schema, records or event log")
	}
	if err = st.SetShare(ctx, base.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	views, err := st.Views(ctx, base.ID)
	if err != nil || len(views) != 1 {
		t.Fatalf("views=%v err=%v", views, err)
	}
	view := views[0]
	view.Config = json.RawMessage(`{"locked":true}`)
	if _, err = st.UpdateView(ctx, view); err != nil {
		t.Fatal(err)
	}
	if _, err = st.ImportBaseCSV(ctx, guard, base.ID, build); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("locked view: %v", err)
	}
	view.Config = json.RawMessage(`{}`)
	if _, err = st.UpdateView(ctx, view); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	if _, err = st.ImportBaseCSV(cancelled, guard, base.ID, func(fields []store.Field) (store.BaseImportPlan, error) {
		plan, e := build(fields)
		cancel()
		return plan, e
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled during planning: %v", err)
	}
	gotFields, _ = st.Fields(ctx, base.ID)
	gotRecords, _ = st.Records(ctx, base.ID)
	gotHead, _ = st.BtHead(ctx, base.ID)
	if len(gotFields) != len(fields) || len(gotRecords) != len(records) || gotHead != head {
		t.Fatal("canceled import mutated data")
	}
	count, err := st.ImportBaseCSV(ctx, guard, base.ID, build)
	if err != nil || count != 1 {
		t.Fatalf("import count=%d err=%v", count, err)
	}
	gotFields, _ = st.Fields(ctx, base.ID)
	gotRecords, _ = st.Records(ctx, base.ID)
	gotHead, _ = st.BtHead(ctx, base.ID)
	if len(gotFields) != len(fields)+1 || len(gotRecords) != len(records)+1 || gotHead <= head {
		t.Fatalf("partial import fields=%d records=%d head=%d", len(gotFields), len(gotRecords), gotHead)
	}
	if string(gotRecords[len(gotRecords)-1].Cells[fmt.Sprint(gotFields[len(gotFields)-1].ID)]) != "3" {
		t.Fatalf("wrong imported values: %+v", gotRecords[len(gotRecords)-1])
	}
	return base, guard
}

func TestMemoryAtomicBaseImport(t *testing.T) { checkAtomicBaseImport(t, store.NewMemory()) }

func TestPostgresAtomicBaseImport(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_import_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
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
	st := &store.Postgres{Pool: pool}
	base, guard := checkAtomicBaseImport(t, st)
	beforeFields, _ := st.Fields(ctx, base.ID)
	beforeRecords, _ := st.Records(ctx, base.ID)
	beforeHead, _ := st.BtHead(ctx, base.ID)
	if _, err = pool.Exec(ctx, `ALTER TABLE base_records ADD CONSTRAINT fail_csv_test CHECK (NOT (cells::text LIKE '%fail_csv_test%'))`); err != nil {
		t.Fatal(err)
	}
	_, err = st.ImportBaseCSV(ctx, guard, base.ID, func([]store.Field) (store.BaseImportPlan, error) {
		return store.BaseImportPlan{Columns: []store.ImportColumn{{New: store.Field{Name: "rollback", Type: "text"}}}, Rows: []map[int]json.RawMessage{{0: json.RawMessage(`"ok"`)}, {0: json.RawMessage(`"fail_csv_test"`)}}}, nil
	})
	if err == nil {
		t.Fatal("injected second row failure succeeded")
	}
	afterFields, _ := st.Fields(ctx, base.ID)
	afterRecords, _ := st.Records(ctx, base.ID)
	afterHead, _ := st.BtHead(ctx, base.ID)
	if len(afterFields) != len(beforeFields) || len(afterRecords) != len(beforeRecords) || afterHead != beforeHead {
		t.Fatal("failed SQL transaction leaked partial import")
	}
	clockCalls := 0
	expiresDuringImport := guard
	expiresDuringImport.Now = func() time.Time {
		clockCalls++
		if clockCalls >= 2 {
			return time.Now().Add(2 * time.Hour)
		}
		return time.Now()
	}
	_, err = st.ImportBaseCSV(ctx, expiresDuringImport, base.ID, func([]store.Field) (store.BaseImportPlan, error) {
		return store.BaseImportPlan{Columns: []store.ImportColumn{{New: store.Field{Name: "expiry", Type: "text"}}}, Rows: []map[int]json.RawMessage{{0: json.RawMessage(`"value"`)}}}, nil
	})
	if !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("session expires before commit: %v", err)
	}
	afterFields, _ = st.Fields(ctx, base.ID)
	afterRecords, _ = st.Records(ctx, base.ID)
	afterHead, _ = st.BtHead(ctx, base.ID)
	if len(afterFields) != len(beforeFields) || len(afterRecords) != len(beforeRecords) || afterHead != beforeHead {
		t.Fatal("expired transaction leaked partial import")
	}

	// Changing a field type and converting existing cells is one transaction.
	// An import must wait for both parts and build against the committed schema.
	oldField := beforeFields[len(beforeFields)-1]
	newField := oldField
	newField.Type = "text"
	conversionEntered, conversionRelease := make(chan struct{}), make(chan struct{})
	conversionDone := make(chan error, 1)
	go func() {
		_, e := st.MutateFieldGuarded(ctx, guard, store.FieldMutation{BaseID: base.ID, Before: &oldField, After: &newField, Fields: beforeFields, Convert: func(_, _ store.Field, raw json.RawMessage) json.RawMessage {
			close(conversionEntered)
			<-conversionRelease
			return json.RawMessage(`"3"`)
		}})
		conversionDone <- e
	}()
	<-conversionEntered
	importBuilt, afterConversionDone := make(chan struct{}), make(chan error, 1)
	go func() {
		_, e := st.ImportBaseCSV(ctx, guard, base.ID, func(fields []store.Field) (store.BaseImportPlan, error) {
			close(importBuilt)
			for _, f := range fields {
				if f.ID == oldField.ID && f.Type == "text" {
					return store.BaseImportPlan{Columns: []store.ImportColumn{{ExistingID: f.ID}}, Rows: []map[int]json.RawMessage{{0: json.RawMessage(`"a@b.com"`)}}}, nil
				}
			}
			return store.BaseImportPlan{}, errors.New("import saw stale field type")
		})
		afterConversionDone <- e
	}()
	select {
	case <-importBuilt:
		t.Fatal("import observed schema before cell conversion committed")
	case <-time.After(150 * time.Millisecond):
	}
	close(conversionRelease)
	if e := <-conversionDone; e != nil {
		t.Fatalf("field conversion: %v", e)
	}
	if e := <-afterConversionDone; e != nil {
		t.Fatalf("import after conversion: %v", e)
	}
	convertedRecords, err := st.Records(ctx, base.ID)
	if err != nil || string(convertedRecords[len(convertedRecords)-1].Cells[fmt.Sprint(oldField.ID)]) != `"a@b.com"` {
		t.Fatalf("imported cell changed by conversion: %+v err=%v", convertedRecords, err)
	}

	// While import holds its guard, setting a view lock must wait until the
	// transaction commits; subsequent editor imports must see the lock.
	views, err := st.Views(ctx, base.ID)
	if err != nil || len(views) != 1 {
		t.Fatalf("views=%v err=%v", views, err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	importDone := make(chan error, 1)
	go func() {
		_, e := st.ImportBaseCSV(ctx, guard, base.ID, func(fields []store.Field) (store.BaseImportPlan, error) {
			close(entered)
			<-release
			return store.BaseImportPlan{Columns: []store.ImportColumn{{ExistingID: fields[0].ID}}, Rows: []map[int]json.RawMessage{{0: json.RawMessage(`"before lock"`)}}}, nil
		})
		importDone <- e
	}()
	<-entered
	view := views[0]
	view.Config = json.RawMessage(`{"locked":true}`)
	lockDone := make(chan error, 1)
	go func() { _, e := st.UpdateView(ctx, view); lockDone <- e }()
	select {
	case e := <-lockDone:
		t.Fatalf("view lock bypassed import fence: %v", e)
	case <-time.After(150 * time.Millisecond):
	}
	close(release)
	if e := <-importDone; e != nil {
		t.Fatalf("import: %v", e)
	}
	if e := <-lockDone; e != nil {
		t.Fatalf("lock view: %v", e)
	}
	called := false
	if _, err = st.ImportBaseCSV(ctx, guard, base.ID, func([]store.Field) (store.BaseImportPlan, error) { called = true; return store.BaseImportPlan{}, nil }); !errors.Is(err, store.ErrForbidden) || called {
		t.Fatalf("import after lock: err=%v builder called=%v", err, called)
	}
	view.Config = json.RawMessage(`{}`)
	if _, err = st.UpdateView(ctx, view); err != nil {
		t.Fatal(err)
	}
	// A later event must not commit ahead of the import's uncommitted reload:
	// clients advance by sequence and would otherwise never see that reload.
	headBefore, err := st.BtHead(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	eventEntered, eventRelease := make(chan struct{}), make(chan struct{})
	eventImportDone := make(chan error, 1)
	go func() {
		_, e := st.ImportBaseCSV(ctx, guard, base.ID, func(fields []store.Field) (store.BaseImportPlan, error) {
			close(eventEntered)
			<-eventRelease
			return store.BaseImportPlan{Columns: []store.ImportColumn{{ExistingID: fields[0].ID}}}, nil
		})
		eventImportDone <- e
	}()
	<-eventEntered
	laterEvent := make(chan error, 1)
	go func() { _, e := st.AppendBtEvent(ctx, base.ID, json.RawMessage(`{"kind":"later"}`)); laterEvent <- e }()
	select {
	case e := <-laterEvent:
		t.Fatalf("later event bypassed transaction fence: %v", e)
	case <-time.After(150 * time.Millisecond):
	}
	close(eventRelease)
	if e := <-eventImportDone; e != nil {
		t.Fatal(e)
	}
	if e := <-laterEvent; e != nil {
		t.Fatal(e)
	}
	events, err := st.BtEventsAfter(ctx, base.ID, headBefore, 10)
	var first, second struct {
		Kind string `json:"kind"`
	}
	if err != nil || len(events) != 2 {
		t.Fatalf("events: %+v err=%v", events, err)
	}
	if json.Unmarshal(events[0].Body, &first) != nil || json.Unmarshal(events[1].Body, &second) != nil || first.Kind != "reload" || second.Kind != "later" {
		t.Fatalf("event order: %+v err=%v", events, err)
	}
	entered2, release2 := make(chan struct{}), make(chan struct{})
	importDone2 := make(chan error, 1)
	go func() {
		_, e := st.ImportBaseCSV(ctx, guard, base.ID, func(fields []store.Field) (store.BaseImportPlan, error) {
			close(entered2)
			<-release2
			return store.BaseImportPlan{Columns: []store.ImportColumn{{ExistingID: fields[0].ID}}, Rows: []map[int]json.RawMessage{{0: json.RawMessage(`"before revoke"`)}}}, nil
		})
		importDone2 <- e
	}()
	<-entered2
	revokeDone := make(chan error, 1)
	go func() { revokeDone <- st.SetShare(ctx, base.ID, guard.UserID, "") }()
	select {
	case e := <-revokeDone:
		t.Fatalf("revocation bypassed import fence: %v", e)
	case <-time.After(150 * time.Millisecond):
	}
	close(release2)
	if e := <-importDone2; e != nil {
		t.Fatalf("import before revoke: %v", e)
	}
	if e := <-revokeDone; e != nil {
		t.Fatalf("revoke: %v", e)
	}
	called = false
	if _, err = st.ImportBaseCSV(ctx, guard, base.ID, func([]store.Field) (store.BaseImportPlan, error) { called = true; return store.BaseImportPlan{}, nil }); !errors.Is(err, store.ErrForbidden) || called {
		t.Fatalf("import after revoke: err=%v builder called=%v", err, called)
	}
	if err = st.SetShare(ctx, base.ID, guard.UserID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	entered3, release3 := make(chan struct{}), make(chan struct{})
	importDone3 := make(chan error, 1)
	go func() {
		_, e := st.ImportBaseCSV(ctx, guard, base.ID, func(fields []store.Field) (store.BaseImportPlan, error) {
			close(entered3)
			<-release3
			return store.BaseImportPlan{Columns: []store.ImportColumn{{ExistingID: fields[0].ID}}}, nil
		})
		importDone3 <- e
	}()
	<-entered3
	logoutDone := make(chan error, 1)
	go func() { logoutDone <- st.DeleteSession(ctx, guard.SessionHash) }()
	select {
	case e := <-logoutDone:
		t.Fatalf("logout bypassed import fence: %v", e)
	case <-time.After(150 * time.Millisecond):
	}
	close(release3)
	if e := <-importDone3; e != nil {
		t.Fatalf("import before logout: %v", e)
	}
	if e := <-logoutDone; e != nil {
		t.Fatalf("logout: %v", e)
	}
	called = false
	if _, err = st.ImportBaseCSV(ctx, guard, base.ID, func([]store.Field) (store.BaseImportPlan, error) { called = true; return store.BaseImportPlan{}, nil }); !errors.Is(err, store.ErrUnauthenticated) || called {
		t.Fatalf("import after logout: err=%v builder called=%v", err, called)
	}
}
