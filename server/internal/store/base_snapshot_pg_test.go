package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresBaseReadSnapshot(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_snapshot_%d", time.Now().UnixNano())
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
	s := &store.Postgres{Pool: pool}
	owner, ws, err := s.CreateUser(ctx, "snapshot-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	other, otherWS, err := s.CreateUser(ctx, "snapshot-other@example.test", "Other", "hash")
	if err != nil {
		t.Fatal(err)
	}
	base, err := s.CreateBase(ctx, ws.ID, owner.ID, nil, "before")
	if err != nil {
		t.Fatal(err)
	}
	field, err := s.AddField(ctx, store.Field{BaseID: base.ID, Type: "text", Name: "Text"})
	if err != nil {
		t.Fatal(err)
	}
	row, err := s.AddRecord(ctx, store.Record{BaseID: base.ID, Cells: map[string]json.RawMessage{fmt.Sprint(field.ID): json.RawMessage(`"before"`)}})
	if err != nil {
		t.Fatal(err)
	}

	called := false
	if err := s.WithBaseReadSnapshot(ctx, other.ID, base.ID, func(store.BaseSnapshotReader) error { called = true; return nil }); !errors.Is(err, store.ErrNotFound) || called {
		t.Fatalf("unauthorized snapshot err=%v called=%v", err, called)
	}
	target, err := s.CreateBase(ctx, ws.ID, owner.ID, nil, "target")
	if err != nil {
		t.Fatal(err)
	}
	targetRow, err := s.AddRecord(ctx, store.Record{BaseID: target.ID})
	if err != nil {
		t.Fatal(err)
	}
	link, err := s.AddField(ctx, store.Field{BaseID: base.ID, Type: "link", Name: "Link", Options: []string{fmt.Sprint(target.ID)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetLinks(ctx, base.ID, link.ID, row.ID, []int64{targetRow.ID}); err != nil {
		t.Fatal(err)
	}
	privateSource, err := s.CreateBase(ctx, otherWS.ID, other.ID, nil, "private source")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddField(ctx, store.Field{BaseID: privateSource.ID, Type: "link", Name: "Private link", Options: []string{fmt.Sprint(target.ID)}}); err != nil {
		t.Fatal(err)
	}
	view, err := s.AddView(ctx, store.View{BaseID: base.ID, Type: "grid", Name: "View"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'member')`, ws.ID, other.ID); err != nil {
		t.Fatal(err)
	}
	err = s.WithBaseReadSnapshot(ctx, owner.ID, base.ID, func(reader store.BaseSnapshotReader) error {
		meta, err := reader.GetDoc(ctx, owner.ID, base.ID)
		if err != nil || meta.Title != "before" {
			return fmt.Errorf("initial meta=%+v err=%v", meta, err)
		}
		fields, err := reader.Fields(ctx, base.ID)
		if err != nil || len(fields) != 2 {
			return fmt.Errorf("fields=%+v err=%v", fields, err)
		}
		if _, err := reader.GetDoc(ctx, other.ID, target.ID); err != nil {
			return fmt.Errorf("initial target access: %w", err)
		}
		before, err := reader.QueryRecordsConstrained(ctx, base.ID, fields, nil, btquery.Config{}, 10000)
		if err != nil || len(before) != 1 || string(before[0].Cells[fmt.Sprint(field.ID)]) != `"before"` {
			return fmt.Errorf("before=%+v err=%v", before, err)
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `UPDATE nodes SET title='after' WHERE id=$1`, base.ID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE base_records SET cells=jsonb_build_object($2::text, 'after'::text) WHERE id=$1`, row.ID, fmt.Sprint(field.ID)); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO bt_events(base_id,body) VALUES ($1,'{"kind":"reload"}'::jsonb)`, base.ID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, ws.ID, other.ID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM bt_links WHERE field_id=$1`, link.ID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE bt_views SET name='changed' WHERE id=$1`, view.ID); err != nil {
			return err
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		after, err := reader.QueryRecordsConstrained(ctx, base.ID, fields, nil, btquery.Config{}, 10000)
		if err != nil || len(after) != 1 || string(after[0].Cells[fmt.Sprint(field.ID)]) != `"before"` {
			return fmt.Errorf("snapshot changed=%+v err=%v", after, err)
		}
		head, err := reader.BtHead(ctx, base.ID)
		if err != nil || head != 0 {
			return fmt.Errorf("snapshot head=%d err=%v", head, err)
		}
		meta, err = reader.GetDoc(ctx, owner.ID, base.ID)
		if err != nil || meta.Title != "before" {
			return fmt.Errorf("snapshot meta=%+v err=%v", meta, err)
		}
		if _, err = reader.GetDoc(ctx, other.ID, target.ID); err != nil {
			return fmt.Errorf("target access changed inside snapshot: %w", err)
		}
		links, err := reader.LinksForRecords(ctx, link.ID, []int64{row.ID})
		if err != nil || len(links[row.ID]) != 1 || links[row.ID][0] != targetRow.ID {
			return fmt.Errorf("snapshot links=%v err=%v", links, err)
		}
		reverse, err := reader.LinksToRecords(ctx, link.ID, []int64{targetRow.ID, targetRow.ID})
		if err != nil || len(reverse[targetRow.ID]) != 1 || reverse[targetRow.ID][0] != row.ID {
			return fmt.Errorf("snapshot reverse=%v err=%v", reverse, err)
		}
		targetFields, err := reader.Fields(ctx, target.ID)
		if err != nil {
			return err
		}
		targets, err := reader.RecordsConstrainedByIDs(ctx, target.ID, []int64{targetRow.ID, targetRow.ID, -1}, targetFields, nil)
		if err != nil || len(targets) != 1 || targets[0].ID != targetRow.ID {
			return fmt.Errorf("snapshot target rows=%v err=%v", targets, err)
		}
		refs, err := reader.LinkFieldsTargeting(ctx, target.ID)
		if err != nil || len(refs) != 1 || refs[0].FieldID != link.ID {
			return fmt.Errorf("snapshot refs=%v err=%v", refs, err)
		}
		views, err := reader.Views(ctx, base.ID)
		if err != nil || len(views) != 1 || views[0].Name != "View" {
			return fmt.Errorf("snapshot views=%v err=%v", views, err)
		}
		members, err := reader.WorkspaceMembers(ctx, ws.ID)
		if err != nil || len(members) != 2 {
			return fmt.Errorf("snapshot members=%v err=%v", members, err)
		}
		workspaces, err := reader.Workspaces(ctx, other.ID)
		if err != nil || len(workspaces) != 2 {
			return fmt.Errorf("snapshot workspaces=%v err=%v", workspaces, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = s.WithBaseReadSnapshot(ctx, owner.ID, base.ID, func(reader store.BaseSnapshotReader) error {
		meta, err := reader.GetDoc(ctx, owner.ID, base.ID)
		if err != nil || meta.Title != "after" {
			return fmt.Errorf("new meta=%+v err=%v", meta, err)
		}
		head, err := reader.BtHead(ctx, base.ID)
		if err != nil || head == 0 {
			return fmt.Errorf("new head=%d err=%v", head, err)
		}
		if _, err := reader.GetDoc(ctx, other.ID, target.ID); !errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("revoked target access: %v", err)
		}
		links, err := reader.LinksForRecords(ctx, link.ID, []int64{row.ID})
		if err != nil || len(links[row.ID]) != 0 {
			return fmt.Errorf("new links=%v err=%v", links, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Exact referenced IDs must not inherit the first-page limit or bypass a
	// locked predicate. Exercise more than one SQL batch with duplicates.
	targetField, err := s.AddField(ctx, store.Field{BaseID: target.ID, Type: "text", Name: "Visibility"})
	if err != nil {
		t.Fatal(err)
	}
	inserted, err := pool.Query(ctx, `INSERT INTO base_records(base_id,cells,position)
		SELECT $1,jsonb_build_object($2::text, CASE WHEN n % 2 = 0 THEN 'allowed' ELSE 'hidden' END),n
		FROM generate_series(1,1102) n RETURNING id`, target.ID, fmt.Sprint(targetField.ID))
	if err != nil {
		t.Fatal(err)
	}
	var requested []int64
	for inserted.Next() {
		var id int64
		if err := inserted.Scan(&id); err != nil {
			t.Fatal(err)
		}
		requested = append(requested, id)
	}
	if err := inserted.Err(); err != nil {
		t.Fatal(err)
	}
	inserted.Close()
	if len(requested) != 1102 {
		t.Fatalf("inserted=%d", len(requested))
	}
	requested = append(requested, requested[1])
	mandatory := []btquery.Config{{Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: targetField.ID, Op: "is", V: "allowed"}}}}}
	secondSource, err := s.AddRecord(ctx, store.Record{BaseID: base.ID, Cells: map[string]json.RawMessage{fmt.Sprint(field.ID): json.RawMessage(`"hidden"`)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetLinks(ctx, base.ID, link.ID, row.ID, []int64{requested[0], requested[1]}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLinks(ctx, base.ID, link.ID, secondSource.ID, []int64{requested[1]}); err != nil {
		t.Fatal(err)
	}
	err = s.WithBaseReadSnapshot(ctx, owner.ID, base.ID, func(reader store.BaseSnapshotReader) error {
		fields, err := reader.Fields(ctx, target.ID)
		if err != nil {
			return err
		}
		records, err := reader.RecordsConstrainedByIDs(ctx, target.ID, requested, fields, mandatory)
		if err != nil {
			return err
		}
		if len(records) != 551 {
			return fmt.Errorf("expected 551 authorized records, got %d", len(records))
		}
		for i, record := range records {
			if record.ID != requested[i*2+1] {
				return fmt.Errorf("order at %d: got %d", i, record.ID)
			}
		}
		forward, err := reader.LinksForRecordsConstrained(ctx, link.ID, []int64{row.ID}, target.ID, fields, mandatory)
		if err != nil || len(forward[row.ID]) != 1 || forward[row.ID][0] != requested[1] {
			return fmt.Errorf("authorized forward links=%v err=%v", forward, err)
		}
		sourceFields, err := reader.Fields(ctx, base.ID)
		if err != nil {
			return err
		}
		sourcePolicy := []btquery.Config{{Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: field.ID, Op: "is", V: "after"}}}}}
		reverse, err := reader.LinksToRecordsConstrained(ctx, link.ID, []int64{requested[1]}, base.ID, sourceFields, sourcePolicy)
		if err != nil || len(reverse[requested[1]]) != 1 || reverse[requested[1]][0] != row.ID {
			return fmt.Errorf("authorized reverse links=%v err=%v", reverse, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Hidden reverse fields must not exhaust the visible-field budget before
	// a later, authorized reverse field is examined.
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'member')`, ws.ID, other.ID); err != nil {
		t.Fatal(err)
	}
	reverseBase, err := s.CreateBase(ctx, ws.ID, owner.ID, nil, "reverse source")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddField(ctx, store.Field{BaseID: reverseBase.ID, Type: "text", Name: "Title"}); err != nil {
		t.Fatal(err)
	}
	insertedFields, err := pool.Query(ctx, `INSERT INTO base_fields(base_id,name,type,options,position)
		SELECT $1, 'hidden-' || n, 'link', jsonb_build_array($2::text), n
		FROM generate_series(1,1001) n RETURNING id`, reverseBase.ID, fmt.Sprint(target.ID))
	if err != nil {
		t.Fatal(err)
	}
	var hiddenIDs []int64
	for insertedFields.Next() {
		var id int64
		if err := insertedFields.Scan(&id); err != nil {
			t.Fatal(err)
		}
		hiddenIDs = append(hiddenIDs, id)
	}
	if err := insertedFields.Err(); err != nil {
		t.Fatal(err)
	}
	insertedFields.Close()
	visibleReverse, err := s.AddField(ctx, store.Field{BaseID: reverseBase.ID, Type: "link", Name: "Visible reverse", Options: []string{fmt.Sprint(target.ID)}})
	if err != nil {
		t.Fatal(err)
	}
	config, err := json.Marshal(btquery.Config{Locked: true, Hidden: hiddenIDs})
	if err != nil {
		t.Fatal(err)
	}
	reverseView, err := s.AddView(ctx, store.View{BaseID: reverseBase.ID, Type: "grid", Name: "Restricted", Config: config})
	if err != nil {
		t.Fatal(err)
	}
	err = s.WithBaseReadSnapshot(ctx, other.ID, target.ID, func(reader store.BaseSnapshotReader) error {
		refs, err := reader.LinkFieldsTargeting(ctx, target.ID)
		if err != nil {
			return err
		}
		found := false
		for _, ref := range refs {
			if ref.BaseID == reverseBase.ID {
				if ref.FieldID != visibleReverse.ID {
					return fmt.Errorf("hidden reverse field leaked: %d", ref.FieldID)
				}
				found = true
			}
		}
		if !found {
			return errors.New("visible reverse field after hidden candidates was omitted")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE bt_views SET config = '{"locked":true,"hidden":[9223372036854775807]}'::jsonb WHERE id=$1`, reverseView.ID); err != nil {
		t.Fatal(err)
	}
	err = s.WithBaseReadSnapshot(ctx, other.ID, target.ID, func(reader store.BaseSnapshotReader) error {
		_, err := reader.LinkFieldsTargeting(ctx, target.ID)
		return err
	})
	if err == nil {
		t.Fatal("invalid locked reverse policy must not be treated as visible")
	}
	cancelled, cancel := context.WithCancel(ctx)
	err = s.WithBaseReadSnapshot(cancelled, owner.ID, base.ID, func(store.BaseSnapshotReader) error { cancel(); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled snapshot: %v", err)
	}
}
