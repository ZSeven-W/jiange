package store_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func formTestSnapshot(t *testing.T, st store.Store, baseID, viewID int64) *store.PublicFormPublishSnapshot {
	t.Helper()
	views, err := st.Views(context.Background(), baseID)
	if err != nil {
		t.Fatal(err)
	}
	fields, err := st.Fields(context.Background(), baseID)
	if err != nil {
		t.Fatal(err)
	}
	if fields == nil {
		fields = []store.Field{}
	}
	for _, view := range views {
		if view.ID == viewID {
			return &store.PublicFormPublishSnapshot{Config: view.Config, Fields: fields, Prepare: func(v store.View, _ []store.Field) (json.RawMessage, error) { return v.Config, nil }}
		}
	}
	t.Fatal("missing test view")
	return nil
}

func checkPublicFormAtomic(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "form-atomic@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateBase(ctx, ws.ID, owner.ID, nil, "Form")
	if err != nil {
		t.Fatal(err)
	}
	field, err := st.AddField(ctx, store.Field{BaseID: base.ID, Name: "反馈", Type: "text"})
	if err != nil {
		t.Fatal(err)
	}
	view, err := st.AddView(ctx, store.View{BaseID: base.ID, Type: "form", Name: "Form", Config: json.RawMessage(`{"fields":[]}`)})
	if err != nil {
		t.Fatal(err)
	}
	session := []byte("form-atomic-session")
	if err := st.CreateSession(ctx, session, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	guard := store.BaseWriteGuard{UserID: owner.ID, SessionHash: session}
	hash := sha256.Sum256([]byte("form-atomic-token"))
	if published, revision, err := st.PublicFormPublished(ctx, guard, base.ID, view.ID); err != nil || published || revision != 0 {
		t.Fatalf("default public=%v revision=%d err=%v", published, revision, err)
	}
	if _, _, err := st.LookupPublicForm(ctx, hash[:]); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unpublished lookup: %v", err)
	}
	if revision, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 0, hash[:], formTestSnapshot(t, st, base.ID, view.ID)); err != nil || revision != 1 {
		t.Fatal(err)
	}
	if published, revision, err := st.PublicFormPublished(ctx, guard, base.ID, view.ID); err != nil || !published || revision != 1 {
		t.Fatalf("published=%v revision=%d err=%v", published, revision, err)
	}
	if gotBase, gotView, err := st.LookupPublicForm(ctx, hash[:]); err != nil || gotBase != base.ID || gotView != view.ID {
		t.Fatalf("lookup=%d/%d err=%v", gotBase, gotView, err)
	}
	actualView, actualFields, err := st.ReadPublicForm(ctx, base.ID, view.ID, hash[:])
	if err != nil || actualView.ID != view.ID || len(actualFields) != 1 || actualFields[0].ID != field.ID {
		t.Fatalf("read form=%+v fields=%+v err=%v", actualView, actualFields, err)
	}
	validate := func(v store.View, fields []store.Field) (map[string]json.RawMessage, error) {
		if v.ID != view.ID || len(fields) != 1 || fields[0].ID != field.ID {
			return nil, fmt.Errorf("stale form: %+v %+v", v, fields)
		}
		return map[string]json.RawMessage{strconv.FormatInt(field.ID, 10): json.RawMessage(`"hello"`)}, nil
	}
	before, err := st.BtHead(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := st.SubmitPublicForm(ctx, base.ID, view.ID, hash[:], validate)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := st.Records(ctx, base.ID)
	if err != nil || len(rows) != 1 || rows[0].ID != rec.ID {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
	events, err := st.BtEventsAfter(ctx, base.ID, before, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%+v err=%v", events, err)
	}
	var event struct {
		Kind   string       `json:"kind"`
		Op     string       `json:"op"`
		Record store.Record `json:"record"`
	}
	if err := json.Unmarshal(events[0].Body, &event); err != nil || event.Kind != "record" || event.Op != "add" || event.Record.ID != rec.ID {
		t.Fatalf("event=%+v err=%v", event, err)
	}

	rejected := errors.New("validation rejected")
	if _, err := st.SubmitPublicForm(ctx, base.ID, view.ID, hash[:], func(store.View, []store.Field) (map[string]json.RawMessage, error) { return nil, rejected }); !errors.Is(err, rejected) {
		t.Fatalf("validator error: %v", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := st.SubmitPublicForm(canceled, base.ID, view.ID, hash[:], validate); err == nil {
		t.Fatal("canceled submit succeeded")
	}
	if _, err := st.SubmitPublicForm(ctx, base.ID, view.ID+999999, hash[:], validate); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing form: %v", err)
	}
	rows, _ = st.Records(ctx, base.ID)
	after, _ := st.BtHead(ctx, base.ID)
	if len(rows) != 1 || after != events[0].Seq {
		t.Fatalf("failed submit changed state: rows=%d head=%d", len(rows), after)
	}

	// Config updates must wait until validation, record and event have committed.
	started, release := make(chan struct{}), make(chan struct{})
	submitDone, updateDone := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := st.SubmitPublicForm(ctx, base.ID, view.ID, hash[:], func(v store.View, fields []store.Field) (map[string]json.RawMessage, error) {
			close(started)
			<-release
			return validate(v, fields)
		})
		submitDone <- err
	}()
	<-started
	go func() {
		v := view
		v.Config = json.RawMessage(`{"fields":[],"title":"changed"}`)
		_, err := st.UpdateView(ctx, v)
		updateDone <- err
	}()
	select {
	case err := <-updateDone:
		close(release)
		t.Fatalf("view changed during submit: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-submitDone; err != nil {
		t.Fatal(err)
	}
	if err := <-updateDone; err != nil {
		t.Fatal(err)
	}
	if _, err := st.SubmitPublicForm(ctx, base.ID, view.ID, hash[:], func(v store.View, _ []store.Field) (map[string]json.RawMessage, error) {
		var cfg struct {
			Title string `json:"title"`
		}
		if json.Unmarshal(v.Config, &cfg) != nil || cfg.Title != "changed" {
			return nil, fmt.Errorf("stale config %s", v.Config)
		}
		return map[string]json.RawMessage{strconv.FormatInt(field.ID, 10): json.RawMessage(`"fresh"`)}, nil
	}); err != nil {
		t.Fatal(err)
	}
	// Rotation invalidates the old token. A close must wait for an in-flight
	// submission and reject all submissions which start after it commits.
	nextHash := sha256.Sum256([]byte("form-atomic-token-next"))
	snapshot := formTestSnapshot(t, st, base.ID, view.ID)
	if _, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 1, nextHash[:], snapshot); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.LookupPublicForm(ctx, hash[:]); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rotated token lookup: %v", err)
	}
	if _, err := st.SubmitPublicForm(ctx, base.ID, view.ID, hash[:], validate); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rotated token submit: %v", err)
	}
	started2, release2 := make(chan struct{}), make(chan struct{})
	submitDone2, closeDone := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := st.SubmitPublicForm(ctx, base.ID, view.ID, nextHash[:], func(v store.View, fields []store.Field) (map[string]json.RawMessage, error) {
			close(started2)
			<-release2
			return validate(v, fields)
		})
		submitDone2 <- err
	}()
	<-started2
	go func() { _, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 2, nil, nil); closeDone <- err }()
	select {
	case err := <-closeDone:
		close(release2)
		t.Fatalf("close overtook active submit: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release2)
	if err := <-submitDone2; err != nil {
		t.Fatal(err)
	}
	if err := <-closeDone; err != nil {
		t.Fatal(err)
	}
	if _, err := st.SubmitPublicForm(ctx, base.ID, view.ID, nextHash[:], validate); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("closed token submit: %v", err)
	}
	if published, revision, err := st.PublicFormPublished(ctx, guard, base.ID, view.ID); err != nil || published || revision != 3 {
		t.Fatalf("closed published=%v revision=%d err=%v", published, revision, err)
	}
	// Failed validation consumes quota, preventing a leaked token from being
	// used for unlimited validation/automation work.
	if _, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 3, nextHash[:], snapshot); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		if _, err := st.SubmitPublicForm(ctx, base.ID, view.ID, nextHash[:], func(store.View, []store.Field) (map[string]json.RawMessage, error) { return nil, rejected }); !errors.Is(err, rejected) {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	if _, err := st.SubmitPublicForm(ctx, base.ID, view.ID, nextHash[:], validate); !errors.Is(err, store.ErrPublicFormRateLimited) {
		t.Fatalf("limit: %v", err)
	}
	if _, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 4, hash[:], snapshot); err != nil {
		t.Fatal(err)
	}
	if err := st.Trash(ctx, base.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.ReadPublicForm(ctx, base.ID, view.ID, hash[:]); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("trashed form read: %v", err)
	}
	if _, err := st.SubmitPublicForm(ctx, base.ID, view.ID, hash[:], validate); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("trashed form submit: %v", err)
	}
}

func TestMemoryPublicFormAtomic(t *testing.T) { checkPublicFormAtomic(t, store.NewMemory()) }

func checkPublicFormRevisionFence(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "form-fence@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateBase(ctx, ws.ID, owner.ID, nil, "Form")
	if err != nil {
		t.Fatal(err)
	}
	view, err := st.AddView(ctx, store.View{BaseID: base.ID, Type: "form", Name: "Form"})
	if err != nil {
		t.Fatal(err)
	}
	session := []byte("form-fence-session")
	if err := st.CreateSession(ctx, session, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	guard := store.BaseWriteGuard{UserID: owner.ID, SessionHash: session}
	a := sha256.Sum256([]byte("late-publish"))
	b := sha256.Sum256([]byte("concurrent-publish"))
	// Closing even an unpublished form must fence a delayed expected=0 POST.
	snapshot := formTestSnapshot(t, st, base.ID, view.ID)
	if revision, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 0, nil, nil); err != nil || revision != 1 {
		t.Fatalf("first close revision=%d err=%v", revision, err)
	}
	if _, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 0, a[:], snapshot); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("late publication: %v", err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, hash := range [][]byte{a[:], b[:]} {
		wg.Add(1)
		go func(hash []byte) {
			defer wg.Done()
			_, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 1, hash, snapshot)
			results <- err
		}(hash)
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, store.ErrConflict) {
			conflict++
		} else {
			t.Fatalf("parallel publish: %v", err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("parallel publish success=%d conflict=%d", success, conflict)
	}
	if revision, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 2, nil, nil); err != nil || revision != 3 {
		t.Fatalf("close revision=%d err=%v", revision, err)
	}
	if _, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 1, b[:], snapshot); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("ABA stale publish: %v", err)
	}
	if published, revision, err := st.PublicFormPublished(ctx, guard, base.ID, view.ID); err != nil || published || revision != 3 {
		t.Fatalf("status=%v revision=%d err=%v", published, revision, err)
	}
	// An editor cannot change or delete the questions of a live anonymous
	// form. A publication racing an editor's prior configuration change must
	// either see the change and conflict, or publish first and reject it.
	editor, _, err := st.CreateUser(ctx, "form-editor-fence@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, base.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	editorSession := []byte("form-editor-fence-session")
	if err := st.CreateSession(ctx, editorSession, editor.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	editorGuard := store.BaseWriteGuard{UserID: editor.ID, SessionHash: editorSession}
	view3, err := st.AddView(ctx, store.View{BaseID: base.ID, Type: "form", Name: "Concurrent", Config: json.RawMessage(`{"fields":[]}`)})
	if err != nil {
		t.Fatal(err)
	}
	view3Changed := view3
	view3Changed.Config = json.RawMessage(`{"fields":[],"title":"changed"}`)
	view3Snapshot := formTestSnapshot(t, st, base.ID, view3.ID)
	results2 := make(chan error, 2)
	go func() {
		_, err := st.SetPublicFormToken(ctx, guard, base.ID, view3.ID, 0, a[:], view3Snapshot)
		results2 <- err
	}()
	go func() { _, err := st.UpdateViewGuarded(ctx, editorGuard, view3, view3Changed); results2 <- err }()
	succeeded, denied := 0, 0
	for i := 0; i < 2; i++ {
		err := <-results2
		if err == nil {
			succeeded++
		} else if errors.Is(err, store.ErrConflict) || errors.Is(err, store.ErrForbidden) {
			denied++
		} else {
			t.Fatalf("concurrent form mutation: %v", err)
		}
	}
	if succeeded != 1 || denied != 1 {
		t.Fatalf("concurrent publish/update success=%d denied=%d", succeeded, denied)
	}
	published3, revision3, err := st.PublicFormPublished(ctx, guard, base.ID, view3.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !published3 {
		if _, err := st.SetPublicFormToken(ctx, guard, base.ID, view3.ID, revision3, a[:], formTestSnapshot(t, st, base.ID, view3.ID)); err != nil {
			t.Fatal(err)
		}
	}
	views3, err := st.Views(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, current := range views3 {
		if current.ID != view3.ID {
			continue
		}
		after := current
		after.Config = json.RawMessage(`{"fields":[],"title":"unauthorized"}`)
		if _, err := st.UpdateViewGuarded(ctx, editorGuard, current, after); !errors.Is(err, store.ErrForbidden) {
			t.Fatalf("published config edit=%v", err)
		}
		if err := st.DeleteViewGuarded(ctx, editorGuard, base.ID, current.ID); !errors.Is(err, store.ErrForbidden) {
			t.Fatalf("published form delete=%v", err)
		}
	}
	// Converting an unpublished form away and back must not allow an old
	// expected=0 request to revive it, even if no publication row existed.
	v2, err := st.AddView(ctx, store.View{BaseID: base.ID, Type: "form", Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	v2.Type = "grid"
	if _, err = st.UpdateView(ctx, v2); err != nil {
		t.Fatal(err)
	}
	v2.Type = "form"
	if _, err = st.UpdateView(ctx, v2); err != nil {
		t.Fatal(err)
	}
	if _, err = st.SetPublicFormToken(ctx, guard, base.ID, v2.ID, 0, a[:], formTestSnapshot(t, st, base.ID, v2.ID)); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("type conversion revived old request: %v", err)
	}
	if err := st.DeleteSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 3, a[:], snapshot); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("logged-out publication: %v", err)
	}
}

func TestMemoryPublicFormRevisionFence(t *testing.T) {
	checkPublicFormRevisionFence(t, store.NewMemory())
}

func TestPostgresPublicFormAtomic(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_form_atomic_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
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
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	st := &store.Postgres{Pool: pool}
	checkPublicFormAtomic(t, st)
	checkPublicFormRevisionFence(t, st)

	owner, ws, err := st.CreateUser(ctx, "form-rollback@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateBase(ctx, ws.ID, owner.ID, nil, "Rollback")
	if err != nil {
		t.Fatal(err)
	}
	view, err := st.AddView(ctx, store.View{BaseID: base.ID, Type: "form", Name: "Form"})
	if err != nil {
		t.Fatal(err)
	}
	session := []byte("form-rollback-session")
	if err := st.CreateSession(ctx, session, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	guard := store.BaseWriteGuard{UserID: owner.ID, SessionHash: session}
	hash := sha256.Sum256([]byte("form-rollback-token"))
	if _, err := st.SetPublicFormToken(ctx, guard, base.ID, view.ID, 0, hash[:], formTestSnapshot(t, st, base.ID, view.ID)); err != nil {
		t.Fatal(err)
	}
	// A public definition GET is read-only and must not take a global SHARE
	// table lock that blocks an unrelated Base writer.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `LOCK TABLE base_fields IN ROW EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	readCtx, cancelRead := context.WithTimeout(ctx, time.Second)
	_, _, readErr := st.ReadPublicForm(readCtx, base.ID, view.ID, hash[:])
	cancelRead()
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if readErr != nil {
		t.Fatalf("read blocked by unrelated writer: %v", readErr)
	}
	_, err = pool.Exec(ctx, `CREATE FUNCTION fail_form_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `CREATE TRIGGER fail_form_event BEFORE INSERT ON bt_events FOR EACH ROW EXECUTE FUNCTION fail_form_event()`)
	if err != nil {
		t.Fatal(err)
	}
	// If freezing default fields cannot append its reload event, neither the
	// public capability nor the configuration change may be committed.
	defaultView, err := st.AddView(ctx, store.View{BaseID: base.ID, Type: "form", Name: "Default", Config: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	defaultSnapshot := formTestSnapshot(t, st, base.ID, defaultView.ID)
	defaultSnapshot.Prepare = func(store.View, []store.Field) (json.RawMessage, error) {
		return json.RawMessage(`{"fields":[123]}`), nil
	}
	otherHash := sha256.Sum256([]byte("form-rollback-default-token"))
	if _, err := st.SetPublicFormToken(ctx, guard, base.ID, defaultView.ID, 0, otherHash[:], defaultSnapshot); err == nil {
		t.Fatal("event failure published default form")
	}
	if published, revision, err := st.PublicFormPublished(ctx, guard, base.ID, defaultView.ID); err != nil || published || revision != 0 {
		t.Fatalf("failed publish left state published=%v revision=%d err=%v", published, revision, err)
	}
	views, err := st.Views(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range views {
		if v.ID == defaultView.ID && string(v.Config) != "{}" {
			t.Fatalf("failed publish changed config=%s", v.Config)
		}
	}
	for i := 0; i < 20; i++ {
		_, err = st.SubmitPublicForm(ctx, base.ID, view.ID, hash[:], func(store.View, []store.Field) (map[string]json.RawMessage, error) {
			return map[string]json.RawMessage{"1": json.RawMessage(`"x"`)}, nil
		})
		if err == nil || errors.Is(err, store.ErrPublicFormRateLimited) {
			t.Fatalf("attempt %d expected injected failure: %v", i, err)
		}
	}
	if _, err = st.SubmitPublicForm(ctx, base.ID, view.ID, hash[:], func(store.View, []store.Field) (map[string]json.RawMessage, error) { return nil, nil }); !errors.Is(err, store.ErrPublicFormRateLimited) {
		t.Fatalf("rolled-back writes bypass quota: %v", err)
	}
	rows, err := st.Records(ctx, base.ID)
	if err != nil || len(rows) != 0 {
		t.Fatalf("record survived event failure: %+v %v", rows, err)
	}
}
