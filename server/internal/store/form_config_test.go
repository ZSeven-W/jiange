package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPublicFormSnapshotSemanticComparison(t *testing.T) {
	view := View{BaseID: 7, Config: json.RawMessage(`{"x":1,"a":[9007199254740993,true],"fields":[1]}`)}
	fields := []Field{{ID: 1, BaseID: 7, Name: "A", Type: "text", Position: 1, Options: []string{}}}
	expected := []Field{{ID: 1, Name: "A", Type: "text", Position: 1}}
	if !samePublicFormSnapshot(view, fields, json.RawMessage(`{"fields":[1],"a":[9007199254740993,true],"x":1.0}`), expected) {
		t.Fatal("equivalent snapshot rejected")
	}
	for _, cfg := range []string{`null`, `{`, `{"x":1,"a":[9007199254740992,true],"fields":[1]}`, `{"x":1,"a":[9007199254740993,true],"fields":[2]}`} {
		if samePublicFormSnapshot(view, fields, json.RawMessage(cfg), expected) {
			t.Fatalf("changed config accepted: %s", cfg)
		}
	}
	changed := append([]Field(nil), expected...)
	changed[0].Name = "B"
	if samePublicFormSnapshot(view, fields, view.Config, changed) || samePublicFormSnapshot(view, fields, view.Config, nil) {
		t.Fatal("changed schema accepted")
	}
	fields[0].BaseID = 8
	if samePublicFormSnapshot(view, fields, view.Config, expected) {
		t.Fatal("foreign schema accepted")
	}
	if !PublicFormConfigExtrasEqual(json.RawMessage(`{"locked":true,"title":"before"}`), json.RawMessage(`{"title":"after","fields":[1],"locked":true}`)) {
		t.Fatal("unchanged non-form settings rejected")
	}
	if PublicFormConfigExtrasEqual(json.RawMessage(`{"locked":true}`), json.RawMessage(`{"locked":false,"fields":[1]}`)) {
		t.Fatal("form editor changed unrelated locked setting")
	}
	view.Config = json.RawMessage(`{}`)
	actualRelation := []Field{{ID: 2, BaseID: 7, Name: "关联", Type: "link", Position: 2, Options: []string{"123", "456"}, Formula: "private"}}
	previewRelation := []Field{{ID: 2, Name: "关联", Type: "link", Position: 2}}
	if !samePublicFormSnapshot(view, actualRelation, json.RawMessage(`{}`), previewRelation) {
		t.Fatal("restricted relation options incorrectly invalidate preview")
	}
	previewRelation[0].Type = "text"
	if samePublicFormSnapshot(view, actualRelation, json.RawMessage(`{}`), previewRelation) {
		t.Fatal("unsupported field becoming supported did not invalidate preview")
	}
	if !PublicFormSupportsField("text") || !PublicFormSupportsField("multi_select") || PublicFormSupportsField("link") || PublicFormSupportsField("person") || PublicFormSupportsField("attachment") {
		t.Fatal("public form field capability mismatch")
	}
}

func checkPublicFormConfigCAS(t *testing.T, st Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "form-config-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	viewer, _, err := st.CreateUser(ctx, "form-config-editor@example.test", "Editor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Base")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, base.ID, viewer.ID, RoleEdit); err != nil {
		t.Fatal(err)
	}
	ownerHash, editorHash := []byte("form-config-owner-session"), []byte("form-config-editor-session")
	if err := st.CreateSession(ctx, ownerHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateSession(ctx, editorHash, viewer.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	guard := BaseWriteGuard{UserID: owner.ID, SessionHash: ownerHash}
	other := BaseWriteGuard{UserID: viewer.ID, SessionHash: editorHash}
	view, err := st.AddView(ctx, View{BaseID: base.ID, Type: "form", Name: "Form", Config: json.RawMessage(`{"title":"before"}`)})
	if err != nil {
		t.Fatal(err)
	}
	fields, err := st.Fields(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	build := func(View, []Field) (json.RawMessage, error) {
		return json.RawMessage(`{"title":"after","fields":[1]}`), nil
	}
	if _, err := st.SetPublicFormConfig(ctx, other, base.ID, view.ID, view.Config, fields, build); !errors.Is(err, ErrForbidden) {
		t.Fatalf("editor allowed: %v", err)
	}
	badFields := append([]Field(nil), fields...)
	badFields[0].Name = "stale"
	if _, err := st.SetPublicFormConfig(ctx, guard, base.ID, view.ID, view.Config, badFields, build); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale fields: %v", err)
	}
	if _, err := st.SetPublicFormConfig(ctx, guard, base.ID, view.ID, json.RawMessage(`{"title":"stale"}`), fields, build); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale config: %v", err)
	}
	beforeHead, _ := st.BtHead(ctx, base.ID)
	rejected := errors.New("builder failed")
	if _, err := st.SetPublicFormConfig(ctx, guard, base.ID, view.ID, view.Config, fields, func(View, []Field) (json.RawMessage, error) { return nil, rejected }); !errors.Is(err, rejected) {
		t.Fatalf("builder error: %v", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := st.SetPublicFormConfig(canceled, guard, base.ID, view.ID, view.Config, fields, build); err == nil {
		t.Fatal("canceled update succeeded")
	}
	head, _ := st.BtHead(ctx, base.ID)
	if head != beforeHead {
		t.Fatal("failed update created event")
	}
	updated, err := st.SetPublicFormConfig(ctx, guard, base.ID, view.ID, view.Config, fields, build)
	if err != nil || !samePublicFormConfig(updated.Config, json.RawMessage(`{"fields":[1],"title":"after"}`)) {
		t.Fatalf("update=%+v err=%v", updated, err)
	}
	events, err := st.BtEventsAfter(ctx, base.ID, beforeHead, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("events=%v err=%v", events, err)
	}
	var event struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(events[0].Body, &event); err != nil || event.Kind != "reload" {
		t.Fatalf("event=%+v err=%v", event, err)
	}
	// A schema change that starts while the builder holds the lock must wait;
	// afterwards, the manager's old field snapshot must be rejected.
	started, release := make(chan struct{}), make(chan struct{})
	updateDone, fieldDone := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := st.SetPublicFormConfig(ctx, guard, base.ID, view.ID, updated.Config, fields, func(View, []Field) (json.RawMessage, error) {
			close(started)
			<-release
			return json.RawMessage(`{"title":"concurrent"}`), nil
		})
		updateDone <- err
	}()
	<-started
	go func() {
		_, err := st.AddField(ctx, Field{BaseID: base.ID, Name: "new", Type: "text"})
		fieldDone <- err
	}()
	select {
	case err := <-fieldDone:
		close(release)
		t.Fatalf("field mutation overtook config: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-updateDone; err != nil {
		t.Fatal(err)
	}
	if err := <-fieldDone; err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetPublicFormConfig(ctx, guard, base.ID, view.ID, json.RawMessage(`{"title":"concurrent"}`), fields, build); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale schema accepted: %v", err)
	}
}

func TestMemoryPublicFormConfigCAS(t *testing.T) { checkPublicFormConfigCAS(t, NewMemory()) }

func TestPostgresPublicFormConfigCAS(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_form_config_%d", time.Now().UnixNano())
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
	st := &Postgres{Pool: pool}
	checkPublicFormConfigCAS(t, st)
	owner, ws, err := st.CreateUser(ctx, "form-config-rollback@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Base")
	if err != nil {
		t.Fatal(err)
	}
	view, err := st.AddView(ctx, View{BaseID: base.ID, Type: "form", Name: "F", Config: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	fields, err := st.Fields(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	hash := []byte("form-config-rollback-session")
	if err := st.CreateSession(ctx, hash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	guard := BaseWriteGuard{UserID: owner.ID, SessionHash: hash}
	_, err = pool.Exec(ctx, `CREATE FUNCTION fail_form_config_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `CREATE TRIGGER fail_form_config_event BEFORE INSERT ON bt_events FOR EACH ROW EXECUTE FUNCTION fail_form_config_event()`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = st.SetPublicFormConfig(ctx, guard, base.ID, view.ID, view.Config, fields, func(View, []Field) (json.RawMessage, error) { return json.RawMessage(`{"title":"must rollback"}`), nil })
	if err == nil {
		t.Fatal("injected event failure succeeded")
	}
	views, err := st.Views(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range views {
		if v.ID == view.ID && !samePublicFormConfig(v.Config, json.RawMessage(`{}`)) {
			t.Fatalf("config survived rollback: %s", v.Config)
		}
	}
}
