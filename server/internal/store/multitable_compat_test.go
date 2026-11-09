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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This is a compatibility experiment, not an enabled migration. It exercises
// the current Store SQL against default-only views over the real schema and a
// non-owner legacy role. A complete rollout still needs scoped authorization,
// forms, events, automation, attachments, role provisioning and old-session
// draining; passing this test alone must never enable a second table.
func TestPostgresMultitableCompatibilityViews(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	suffix := time.Now().UnixNano()
	schema := fmt.Sprintf("jiange_mt_compat_%d", suffix)
	role := fmt.Sprintf("jiange_mt_legacy_%d", suffix)
	qs, qr := pgx.Identifier{schema}.Sanitize(), pgx.Identifier{role}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+qs); err != nil {
		t.Fatal(err)
	}
	createdRole := false
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+qs+" CASCADE")
		if createdRole {
			_, _ = admin.Exec(context.Background(), "DROP ROLE IF EXISTS "+qr)
		}
	}()
	if _, err = admin.Exec(ctx, "CREATE ROLE "+qr+" NOLOGIN NOSUPERUSER NOBYPASSRLS"); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42501" {
			t.Skip("test database role cannot create an isolated non-owner role")
		}
		t.Fatal(err)
	}
	createdRole = true
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	owner, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	if _, err = migrate.Up(ctx, owner); err != nil {
		t.Fatal(err)
	}
	st := &Postgres{Pool: owner}
	user, ws, err := st.CreateUser(ctx, "mt-compat@example.test", "兼容测试", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.CreateInitializedBase(ctx, ws.ID, user.ID, nil, "旧表")
	if err != nil {
		t.Fatal(err)
	}
	// The real production schema is modified only inside this isolated schema.
	// Old names expose scope 0; new storage is deliberately not accessible to
	// the legacy role. The function refers to the physical table so each scope
	// has its own primary identity, even though the old view sees only scope 0.
	ddl := `
		ALTER TABLE base_fields ADD COLUMN table_scope bigint NOT NULL DEFAULT 0;
		ALTER TABLE base_records ADD COLUMN table_scope bigint NOT NULL DEFAULT 0;
		ALTER TABLE bt_views ADD COLUMN table_scope bigint NOT NULL DEFAULT 0;
		ALTER TABLE bt_links ADD COLUMN table_scope bigint NOT NULL DEFAULT 0;
		ALTER TABLE bt_events ADD COLUMN table_scope bigint NOT NULL DEFAULT 0;
		ALTER TABLE bt_automations ADD COLUMN table_scope bigint NOT NULL DEFAULT 0;
		ALTER TABLE bt_public_form_links ADD COLUMN table_scope bigint NOT NULL DEFAULT 0;
		DROP INDEX base_fields_one_primary;
		CREATE UNIQUE INDEX base_fields_one_primary_scope ON base_fields(base_id, table_scope) WHERE is_primary;
		ALTER TABLE base_fields RENAME TO base_fields_all;
		ALTER TABLE base_records RENAME TO base_records_all;
		ALTER TABLE bt_views RENAME TO bt_views_all;
		ALTER TABLE bt_links RENAME TO bt_links_all;
		ALTER TABLE bt_events RENAME TO bt_events_all;
		ALTER TABLE bt_automations RENAME TO bt_automations_all;
		ALTER TABLE bt_public_form_links RENAME TO bt_public_form_links_all;
		CREATE VIEW base_fields WITH (security_barrier=true) AS SELECT id,base_id,name,type,options,option_colors,description,formula,position,is_primary,default_value FROM base_fields_all WHERE table_scope=0 WITH LOCAL CHECK OPTION;
		CREATE VIEW base_records WITH (security_barrier=true) AS SELECT id,base_id,cells,position,creator_id,created_at,updated_at FROM base_records_all WHERE table_scope=0 WITH LOCAL CHECK OPTION;
		CREATE VIEW bt_views WITH (security_barrier=true) AS SELECT id,base_id,type,name,config,pos FROM bt_views_all WHERE table_scope=0 WITH LOCAL CHECK OPTION;
		CREATE VIEW bt_links WITH (security_barrier=true) AS SELECT id,base_id,field_id,from_record,to_record FROM bt_links_all WHERE table_scope=0 WITH LOCAL CHECK OPTION;
		CREATE VIEW bt_events WITH (security_barrier=true) AS SELECT id,base_id,body,at,actor_id,actor_kind FROM bt_events_all WHERE table_scope=0 WITH LOCAL CHECK OPTION;
		CREATE VIEW bt_automations WITH (security_barrier=true) AS SELECT id,base_id,name,enabled,trigger_kind,config,last_fired_at FROM bt_automations_all WHERE table_scope=0 WITH LOCAL CHECK OPTION;
		CREATE VIEW bt_public_form_links WITH (security_barrier=true) AS SELECT view_id,base_id,token_hash,revision,window_started,window_count FROM bt_public_form_links_all WHERE table_scope=0 WITH LOCAL CHECK OPTION;
		CREATE OR REPLACE FUNCTION revoke_form_link_on_type_change() RETURNS trigger LANGUAGE plpgsql
		SECURITY DEFINER SET search_path=` + qs + `,pg_catalog AS $$
		BEGIN
		  IF OLD.type = 'form' AND NEW.type <> 'form' THEN
		    INSERT INTO bt_public_form_links_all (view_id, base_id, table_scope, token_hash, revision)
		    VALUES (OLD.id, OLD.base_id, OLD.table_scope, NULL, 1)
		    ON CONFLICT (view_id) DO UPDATE SET token_hash = NULL, revision = bt_public_form_links_all.revision + 1;
		  END IF;
		  RETURN NEW;
		END $$;
		CREATE FUNCTION leak_probe(value text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
		BEGIN
		  IF value='新表私有字段' THEN RAISE EXCEPTION 'hidden row reached caller predicate'; END IF;
		  RETURN true;
		END $$;
		CREATE OR REPLACE FUNCTION base_field_primary_guard() RETURNS trigger
		LANGUAGE plpgsql SECURITY DEFINER SET search_path=` + qs + `,pg_catalog AS $$
		DECLARE primary_id bigint;
		BEGIN
		  IF TG_OP='INSERT' THEN
		    SELECT id INTO primary_id FROM base_fields_all WHERE base_id=NEW.base_id AND table_scope=NEW.table_scope AND is_primary;
		    IF primary_id IS NULL THEN
		      IF EXISTS (SELECT 1 FROM base_fields_all WHERE base_id=NEW.base_id AND table_scope=NEW.table_scope) THEN
		        RAISE EXCEPTION 'scope has fields without a primary field' USING ERRCODE='23514';
		      END IF;
		      NEW.is_primary:=true;
		    ELSIF NEW.is_primary THEN
		      RAISE EXCEPTION 'primary field already exists' USING ERRCODE='23514';
		    END IF;
		    RETURN NEW;
		  ELSIF TG_OP='DELETE' THEN
		    IF OLD.is_primary AND EXISTS (SELECT 1 FROM nodes WHERE id=OLD.base_id) THEN
		      RAISE EXCEPTION 'primary field cannot be deleted' USING ERRCODE='23514';
		    END IF;
		    RETURN OLD;
		  END IF;
		  IF NEW.base_id<>OLD.base_id OR NEW.table_scope<>OLD.table_scope OR NEW.is_primary<>OLD.is_primary THEN
		    RAISE EXCEPTION 'primary identity cannot be changed' USING ERRCODE='23514';
		  END IF;
		  RETURN NEW;
		END $$;
		CREATE FUNCTION legacy_link_scope_guard() RETURNS trigger
		LANGUAGE plpgsql SECURITY DEFINER SET search_path=` + qs + `,pg_catalog AS $$
		BEGIN
		  IF NEW.table_scope=0 AND (
		    NOT EXISTS (SELECT 1 FROM base_fields_all WHERE id=NEW.field_id AND base_id=NEW.base_id AND table_scope=0)
		    OR NOT EXISTS (SELECT 1 FROM base_records_all WHERE id=NEW.from_record AND base_id=NEW.base_id AND table_scope=0)
		    OR NOT EXISTS (SELECT 1 FROM base_records_all WHERE id=NEW.to_record AND table_scope=0)
		  ) THEN
		    RAISE EXCEPTION 'legacy link outside default scope' USING ERRCODE='23514';
		  END IF;
		  RETURN NEW;
		END $$;
		CREATE TRIGGER legacy_link_scope_guard_trigger BEFORE INSERT OR UPDATE ON bt_links_all
		FOR EACH ROW EXECUTE FUNCTION legacy_link_scope_guard();`
	if _, err = owner.Exec(ctx, ddl); err != nil {
		t.Fatal(err)
	}
	var newField, newRecord int64
	if err = owner.QueryRow(ctx, `INSERT INTO base_fields_all(base_id,table_scope,name,type,position,is_primary) VALUES ($1,99,'新表私有字段','text',1,true) RETURNING id`, base.ID).Scan(&newField); err != nil {
		t.Fatal(err)
	}
	cells, _ := json.Marshal(map[string]string{fmt.Sprint(newField): "新表私有内容"})
	if err = owner.QueryRow(ctx, `INSERT INTO base_records_all(base_id,table_scope,cells,position) VALUES ($1,99,$2,1) RETURNING id`, base.ID, cells).Scan(&newRecord); err != nil {
		t.Fatal(err)
	}
	var newView int64
	if err = owner.QueryRow(ctx, `INSERT INTO bt_views_all(base_id,table_scope,type,name,config,pos) VALUES ($1,99,'form','新表视图','{}',1) RETURNING id`, base.ID).Scan(&newView); err != nil {
		t.Fatal(err)
	}
	var privateToken [32]byte
	privateToken[0] = 99
	if _, err = owner.Exec(ctx, `INSERT INTO bt_public_form_links_all(view_id,base_id,table_scope,token_hash,revision) VALUES ($1,$2,99,$3,1)`, newView, base.ID, privateToken[:]); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO bt_automations_all(base_id,table_scope,name,enabled,trigger_kind) VALUES ($1,99,'新表自动化',true,'form_submit')`, base.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO bt_events_all(base_id,table_scope,body) VALUES ($1,99,$2)`, base.ID, json.RawMessage(`{"kind":"record","private":"新表事件"}`)); err != nil {
		t.Fatal(err)
	}
	grant := "GRANT USAGE ON SCHEMA " + qs + " TO " + qr + "; " +
		"GRANT SELECT,UPDATE ON nodes TO " + qr + "; " +
		"GRANT SELECT,INSERT,UPDATE,DELETE ON base_fields,base_records,bt_views,bt_links,bt_events,bt_automations,bt_public_form_links TO " + qr + "; " +
		"GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA " + qs + " TO " + qr
	if _, err = owner.Exec(ctx, grant); err != nil {
		t.Fatal(err)
	}
	legacyCfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	legacyCfg.ConnConfig.RuntimeParams["search_path"] = schema
	legacyCfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, err := c.Exec(ctx, "SET ROLE "+qr)
		return err
	}
	legacy, err := pgxpool.NewWithConfig(ctx, legacyCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Close()
	old := &Postgres{Pool: legacy}
	legacyTx, err := legacy.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = legacyTx.Exec(ctx, `LOCK TABLE base_fields,base_records,bt_links IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		_ = legacyTx.Rollback(ctx)
		t.Fatalf("legacy table lock through views: %v", err)
	}
	if err = legacyTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	fields, err := old.Fields(ctx, base.ID)
	if err != nil || len(fields) != 1 || fields[0].Name != "文本" {
		t.Fatalf("legacy fields: %+v, %v", fields, err)
	}
	records, err := old.Records(ctx, base.ID)
	if err != nil || len(records) != 5 {
		t.Fatalf("legacy records: %+v, %v", records, err)
	}
	views, err := old.Views(ctx, base.ID)
	if err != nil || len(views) != 1 || views[0].Name != "表格" {
		t.Fatalf("legacy views: %+v, %v", views, err)
	}
	head, err := old.BtHead(ctx, base.ID)
	if err != nil || head != 0 {
		t.Fatalf("legacy head included other table event: head=%d err=%v", head, err)
	}
	seq, err := old.AppendBtEvent(ctx, base.ID, json.RawMessage(`{"kind":"reload"}`))
	if err != nil {
		t.Fatalf("legacy event append through view: %v", err)
	}
	events, err := old.BtEventsAfter(ctx, base.ID, 0, 100)
	if err != nil || len(events) != 1 || events[0].Seq != seq {
		t.Fatalf("legacy replay included other table event: events=%+v err=%v", events, err)
	}
	var eventBody map[string]any
	if json.Unmarshal(events[0].Body, &eventBody) != nil || eventBody["kind"] != "reload" || len(eventBody) != 1 {
		t.Fatalf("legacy replay exposed unexpected event: %s", events[0].Body)
	}
	automations, err := old.AllAutomations(ctx)
	if err != nil || len(automations) != 0 {
		t.Fatalf("legacy automation scan included another table: %+v err=%v", automations, err)
	}
	automation, err := old.AddAutomation(ctx, Automation{BaseID: base.ID, Name: "默认表自动化", Enabled: true, TriggerKind: "form_submit"})
	if err != nil {
		t.Fatalf("legacy automation insert through view: %v", err)
	}
	automations, err = old.AllAutomations(ctx)
	if err != nil || len(automations) != 1 || automations[0].ID != automation.ID {
		t.Fatalf("legacy automation scan: %+v err=%v", automations, err)
	}
	if err = old.MarkFired(ctx, automation.ID, time.Now()); err != nil {
		t.Fatalf("legacy automation update through view: %v", err)
	}
	if _, _, err = old.LookupPublicForm(ctx, privateToken[:]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("legacy public form lookup included another table: %v", err)
	}
	// Type changes in the new scope must revoke only that form. In particular
	// their trigger must not create a visible default-scope publication row.
	if _, err = owner.Exec(ctx, `UPDATE bt_views_all SET type='grid' WHERE id=$1`, newView); err != nil {
		t.Fatal(err)
	}
	var revoked bool
	if err = owner.QueryRow(ctx, `SELECT token_hash IS NULL AND revision=2 AND table_scope=99 FROM bt_public_form_links_all WHERE view_id=$1`, newView).Scan(&revoked); err != nil || !revoked {
		t.Fatalf("new table form was not safely revoked: revoked=%v err=%v", revoked, err)
	}
	var leakedForm int
	if err = legacy.QueryRow(ctx, `SELECT count(*) FROM bt_public_form_links WHERE view_id=$1`, newView).Scan(&leakedForm); err != nil || leakedForm != 0 {
		t.Fatalf("legacy view exposed new table form: count=%d err=%v", leakedForm, err)
	}
	// Existing Store insert/update/RETURNING and table locking must still work.
	field, err := old.AddField(ctx, Field{BaseID: base.ID, Name: "旧接口字段", Type: "text"})
	if err != nil {
		t.Fatal(err)
	}
	added, err := old.AddRecord(ctx, Record{BaseID: base.ID, Cells: map[string]json.RawMessage{fmt.Sprint(field.ID): json.RawMessage(`"旧接口写入"`)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = old.SetCells(ctx, base.ID, added.ID, map[string]json.RawMessage{fmt.Sprint(field.ID): json.RawMessage(`"已更新"`)}); err != nil {
		t.Fatal(err)
	}
	if _, err = old.AddView(ctx, View{BaseID: base.ID, Type: "grid", Name: "旧接口视图"}); err != nil {
		t.Fatal(err)
	}
	defaultForm, err := old.AddView(ctx, View{BaseID: base.ID, Type: "form", Name: "默认表收集表"})
	if err != nil {
		t.Fatalf("legacy form insert through view: %v", err)
	}
	var defaultToken [32]byte
	defaultToken[0] = 42
	if _, err = legacy.Exec(ctx, `INSERT INTO bt_public_form_links(view_id,base_id,token_hash,revision) VALUES ($1,$2,$3,1)`, defaultForm.ID, base.ID, defaultToken[:]); err != nil {
		t.Fatalf("legacy publication insert through view: %v", err)
	}
	if gotBase, gotView, err := old.LookupPublicForm(ctx, defaultToken[:]); err != nil || gotBase != base.ID || gotView != defaultForm.ID {
		t.Fatalf("legacy form lookup: base=%d view=%d err=%v", gotBase, gotView, err)
	}
	defaultForm.Type = "grid"
	if _, err = old.UpdateView(ctx, defaultForm); err != nil {
		t.Fatalf("legacy form conversion through view: %v", err)
	}
	if _, _, err = old.LookupPublicForm(ctx, defaultToken[:]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("legacy form conversion did not revoke token: %v", err)
	}
	// Exercise the legacy ON CONFLICT DO NOTHING link path via the view.
	link, err := old.AddField(ctx, Field{BaseID: base.ID, Name: "旧关联", Type: "link"})
	if err != nil {
		t.Fatal(err)
	}
	if err = old.SetLinks(ctx, base.ID, link.ID, records[0].ID, []int64{records[1].ID}); err != nil {
		t.Fatal(err)
	}
	if _, err = legacy.Exec(ctx, `INSERT INTO bt_links(base_id,field_id,from_record,to_record) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, base.ID, link.ID, records[0].ID, records[1].ID); err != nil {
		t.Fatalf("legacy duplicate link through view: %v", err)
	}
	// A known v2 record ID cannot be smuggled through an old link write. The
	// failed replacement must not remove the previously valid default link.
	if err = old.SetLinks(ctx, base.ID, link.ID, records[0].ID, []int64{newRecord}); err == nil {
		t.Fatal("legacy link accepted a record from another table scope")
	}
	links, err := old.LinksForRecords(ctx, link.ID, []int64{records[0].ID})
	if err != nil || len(links[records[0].ID]) != 1 || links[records[0].ID][0] != records[1].ID {
		t.Fatalf("legacy link changed after rejected replacement: %+v, %v", links, err)
	}
	if err = old.SetLinks(ctx, base.ID, link.ID, records[0].ID, []int64{records[1].ID}); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"base_fields_all", "base_records_all", "bt_views_all", "bt_links_all", "bt_events_all", "bt_automations_all", "bt_public_form_links_all"} {
		var count int
		err := legacy.QueryRow(ctx, "SELECT count(*) FROM "+pgx.Identifier{table}.Sanitize()).Scan(&count)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
			t.Fatalf("legacy role accessed physical %s: count=%d err=%v", table, count, err)
		}
	}
	var visibleNewField int
	if err = legacy.QueryRow(ctx, `SELECT count(*) FROM base_fields WHERE id=$1`, newField).Scan(&visibleNewField); err != nil || visibleNewField != 0 {
		t.Fatalf("legacy view exposed new field: count=%d err=%v", visibleNewField, err)
	}
	var filtered int
	if err = legacy.QueryRow(ctx, `SELECT count(*) FROM base_fields WHERE leak_probe(name)`).Scan(&filtered); err != nil || filtered != 3 {
		t.Fatalf("legacy view evaluated caller predicate on hidden rows: count=%d err=%v", filtered, err)
	}
	var privateValue string
	if err = owner.QueryRow(ctx, `SELECT cells->>$2 FROM base_records_all WHERE id=$1 AND table_scope=99`, newRecord, fmt.Sprint(newField)).Scan(&privateValue); err != nil || privateValue != "新表私有内容" {
		t.Fatalf("new scope changed: %q, %v", privateValue, err)
	}
}
