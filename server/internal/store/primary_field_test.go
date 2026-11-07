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

func checkPrimaryField(t *testing.T, st Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "primary-field@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "base")
	if err != nil {
		t.Fatal(err)
	}
	guard := BaseWriteGuard{UserID: owner.ID, SessionHash: []byte("primary-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	fields, err := st.Fields(ctx, base.ID)
	if err != nil || len(fields) != 1 || !fields[0].IsPrimary {
		t.Fatalf("initial fields=%+v err=%v", fields, err)
	}
	primary := fields[0]
	if _, err = st.MutateFieldGuarded(ctx, guard, FieldMutation{BaseID: base.ID, Before: &primary, Fields: fields}); !errors.Is(err, ErrPrimaryField) {
		t.Fatalf("delete primary: %v", err)
	}
	moved := primary
	moved.Position++
	if _, err = st.MutateFieldGuarded(ctx, guard, FieldMutation{BaseID: base.ID, Before: &primary, After: &moved, Fields: fields}); !errors.Is(err, ErrPrimaryField) {
		t.Fatalf("move primary: %v", err)
	}
	// Changing a primary field's type is supported; identity does not change.
	renamed := primary
	renamed.Name = "编号"
	renamed.Type = "number"
	changed, err := st.MutateFieldGuarded(ctx, guard, FieldMutation{BaseID: base.ID, Before: &primary, After: &renamed, Fields: fields, Convert: func(Field, Field, json.RawMessage) json.RawMessage { return nil }})
	if err != nil || !changed.Field.IsPrimary || changed.Field.ID != primary.ID || changed.Field.Type != "number" {
		t.Fatalf("change primary=%+v err=%v", changed, err)
	}
	fields, _ = st.Fields(ctx, base.ID)
	secondary := Field{BaseID: base.ID, Name: "辅助", Type: "text"}
	created, err := st.MutateFieldGuarded(ctx, guard, FieldMutation{BaseID: base.ID, After: &secondary, Fields: fields})
	if err != nil || created.Field.IsPrimary {
		t.Fatalf("secondary=%+v err=%v", created, err)
	}
	fields, _ = st.Fields(ctx, base.ID)
	ids := []int64{primary.ID, created.Field.ID}
	if err := st.ReorderFieldsGuarded(ctx, guard, base.ID, ids, []int64{created.Field.ID, primary.ID}); !errors.Is(err, ErrPrimaryField) {
		t.Fatalf("reorder across primary: %v", err)
	}
	before := created.Field
	after := before
	after.Position = changed.Field.Position - 1
	if _, err = st.MutateFieldGuarded(ctx, guard, FieldMutation{BaseID: base.ID, Before: &before, After: &after, Fields: fields}); !errors.Is(err, ErrPrimaryField) {
		t.Fatalf("move secondary before primary: %v", err)
	}
	views, err := st.Views(ctx, base.ID)
	if err != nil || len(views) != 1 {
		t.Fatalf("views=%v err=%v", views, err)
	}
	view := views[0]
	hidden := view
	hidden.Config = json.RawMessage(fmt.Sprintf(`{"hidden":[%d]}`, primary.ID))
	if _, err = st.UpdateViewGuarded(ctx, guard, view, hidden); !errors.Is(err, ErrPrimaryField) {
		t.Fatalf("new hidden primary: %v", err)
	}
	// Older locked views may already hide the primary; keep the policy intact
	// and permit an owner to unhide it deliberately.
	legacy, err := st.UpdateView(ctx, hidden)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.UpdateViewGuarded(ctx, guard, legacy, view); err != nil {
		t.Fatalf("unhide legacy primary: %v", err)
	}
	// Raw empty bases from older/internal creation gain an identity on their first field.
	empty, err := st.CreateBase(ctx, ws.ID, owner.ID, nil, "empty")
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.AddField(ctx, Field{BaseID: empty.ID, Name: "first", Type: "text"})
	if err != nil || !first.IsPrimary {
		t.Fatalf("first field=%+v err=%v", first, err)
	}
}

func TestMemoryPrimaryField(t *testing.T) { checkPrimaryField(t, NewMemory()) }

func TestPostgresPrimaryField(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_primary_%d", time.Now().UnixNano())
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
	checkPrimaryField(t, &Postgres{Pool: pool})
}

func TestPostgresPrimaryMigrationPreservesExistingData(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_primary_migration_%d", time.Now().UnixNano())
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
	if _, err = pool.Exec(ctx, `CREATE TABLE nodes (id bigint PRIMARY KEY);
		CREATE TABLE base_fields (id bigint PRIMARY KEY,base_id bigint NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,position double precision NOT NULL,name text NOT NULL,type text NOT NULL);
		INSERT INTO nodes VALUES (1),(2),(3);
		INSERT INTO base_fields VALUES (12,1,2,'text title','text'), (11,1,1,'first number','number'), (13,2,9,'other','number')`); err != nil {
		t.Fatal(err)
	}
	migrations, err := migrate.List()
	if err != nil {
		t.Fatal(err)
	}
	var sql string
	for _, migration := range migrations {
		if migration.Version == 24 {
			sql = migration.SQL
		}
	}
	if sql == "" {
		t.Fatal("primary field migration missing")
	}
	if _, err = pool.Exec(ctx, sql); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `SELECT id,name,is_primary FROM base_fields ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type item struct {
		id      int64
		name    string
		primary bool
	}
	var got []item
	for rows.Next() {
		var x item
		if err = rows.Scan(&x.id, &x.name, &x.primary); err != nil {
			t.Fatal(err)
		}
		got = append(got, x)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0] != (item{11, "first number", false}) || got[1] != (item{12, "text title", true}) || got[2] != (item{13, "other", true}) {
		t.Fatalf("migration changed fields: %+v", got)
	}
	if _, err = pool.Exec(ctx, `UPDATE base_fields SET is_primary=true WHERE id=11`); err == nil {
		t.Fatal("duplicate primary was accepted")
	}
	if _, err = pool.Exec(ctx, `DELETE FROM base_fields WHERE id=12`); err == nil {
		t.Fatal("legacy delete removed primary")
	}
	if _, err = pool.Exec(ctx, `INSERT INTO base_fields (id,base_id,position,name,type) VALUES (14,3,1,'legacy insert','text')`); err != nil {
		t.Fatal(err)
	}
	var primary bool
	if err = pool.QueryRow(ctx, `SELECT is_primary FROM base_fields WHERE id=14`).Scan(&primary); err != nil || !primary {
		t.Fatalf("legacy insert primary=%v err=%v", primary, err)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM nodes WHERE id=3`); err != nil {
		t.Fatalf("node cascade must remain possible: %v", err)
	}
}
