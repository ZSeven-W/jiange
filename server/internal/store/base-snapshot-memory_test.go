package store

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/btquery"
)

func TestMemoryBaseSnapshotIsConsistentAndIndependent(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	owner, ws, err := m.CreateUser(ctx, "owner@example.test", "Owner", "owner-secret")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := m.CreateUser(ctx, "guest@example.test", "Guest", "guest-secret")
	if err != nil {
		t.Fatal(err)
	}
	source, err := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Source")
	if err != nil {
		t.Fatal(err)
	}
	target, err := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Private target")
	if err != nil {
		t.Fatal(err)
	}
	if err = m.SetShare(ctx, source.ID, guest.ID, RoleView); err != nil {
		t.Fatal(err)
	}
	fields, err := m.Fields(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	link, err := m.AddField(ctx, Field{BaseID: source.ID, Name: "Link", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	recs, err := m.Records(ctx, source.ID)
	if err != nil || len(recs) == 0 {
		t.Fatalf("records: %v %v", recs, err)
	}
	key := strconv.FormatInt(fields[0].ID, 10)
	if _, err = m.SetCells(ctx, source.ID, recs[0].ID, map[string]json.RawMessage{key: json.RawMessage(`"before"`)}); err != nil {
		t.Fatal(err)
	}
	if err = m.SetLinks(ctx, source.ID, link.ID, recs[0].ID, []int64{123}); err != nil {
		t.Fatal(err)
	}
	beforeHead, err := m.AppendBtEvent(ctx, source.ID, json.RawMessage(`{"kind":"reload"}`))
	if err != nil {
		t.Fatal(err)
	}

	err = m.WithBaseReadSnapshot(ctx, guest.ID, source.ID, func(read BaseSnapshotReader) error {
		if _, err := read.GetDoc(ctx, guest.ID, target.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("private target: %v", err)
		}
		snapshotFields, err := read.Fields(ctx, source.ID)
		if err != nil {
			return err
		}
		rows, err := read.QueryRecordsConstrained(ctx, source.ID, snapshotFields, nil, btquery.Config{}, 10000)
		if err != nil {
			return err
		}
		head, err := read.BtHead(ctx, source.ID)
		if err != nil {
			return err
		}
		if head != beforeHead || string(rows[0].Cells[key]) != `"before"` {
			t.Fatalf("snapshot before write: head=%d cells=%s", head, rows[0].Cells[key])
		}
		members, err := read.WorkspaceMembers(ctx, ws.ID)
		if err != nil {
			return err
		}
		for _, member := range members {
			if member.PasswordHash != "" {
				t.Fatal("snapshot retained password hash")
			}
		}

		// A live writer can complete while the callback is reading the copy.
		if _, err := m.SetCells(ctx, source.ID, recs[0].ID, map[string]json.RawMessage{key: json.RawMessage(`"after"`)}); err != nil {
			return err
		}
		if _, err := m.AppendBtEvent(ctx, source.ID, json.RawMessage(`{"kind":"reload"}`)); err != nil {
			return err
		}
		if err := m.SetShare(ctx, source.ID, guest.ID, ""); err != nil {
			return err
		}
		again, err := read.QueryRecordsConstrained(ctx, source.ID, snapshotFields, nil, btquery.Config{}, 10000)
		if err != nil {
			return err
		}
		againHead, err := read.BtHead(ctx, source.ID)
		if err != nil {
			return err
		}
		if againHead != beforeHead || string(again[0].Cells[key]) != `"before"` {
			t.Fatalf("snapshot changed: head=%d cells=%s", againHead, again[0].Cells[key])
		}
		if _, err := read.GetDoc(ctx, guest.ID, source.ID); err != nil {
			t.Fatalf("snapshot role changed: %v", err)
		}
		// Mutable nested values returned by the private copy cannot alter live data.
		again[0].Cells[key][1] = 'X'
		for i := range snapshotFields {
			if snapshotFields[i].ID == link.ID {
				snapshotFields[i].Options[0] = "999"
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	current, err := m.Records(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if string(current[0].Cells[key]) != `"after"` {
		t.Fatalf("live cells changed through snapshot: %s", current[0].Cells[key])
	}
	currentFields, err := m.Fields(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range currentFields {
		if field.ID == link.ID && field.Options[0] != strconv.FormatInt(target.ID, 10) {
			t.Fatal("live options changed through snapshot")
		}
	}
}

func TestMemoryBaseSnapshotAuthorizationAndCancellation(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	owner, ws, _ := m.CreateUser(ctx, "owner@example.test", "Owner", "")
	guest, _, _ := m.CreateUser(ctx, "guest@example.test", "Guest", "")
	base, err := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Source")
	if err != nil {
		t.Fatal(err)
	}
	called := false
	if err := m.WithBaseReadSnapshot(ctx, guest.ID, base.ID, func(BaseSnapshotReader) error { called = true; return nil }); !errors.Is(err, ErrNotFound) || called {
		t.Fatalf("unauthorized: err=%v called=%v", err, called)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := m.WithBaseReadSnapshot(cancelled, owner.ID, base.ID, func(BaseSnapshotReader) error { called = true; return nil }); !errors.Is(err, context.Canceled) || called {
		t.Fatalf("cancelled: err=%v called=%v", err, called)
	}
}

func TestMemoryBaseSnapshotExactRelatedRecordsBeyondFirstPage(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	owner, ws, _ := m.CreateUser(ctx, "owner@example.test", "Owner", "")
	source, err := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Source")
	if err != nil {
		t.Fatal(err)
	}
	target, err := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Target")
	if err != nil {
		t.Fatal(err)
	}
	forward, err := m.AddField(ctx, Field{BaseID: source.ID, Name: "forward", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	reverse, err := m.AddField(ctx, Field{BaseID: target.ID, Name: "reverse", Type: "link", Options: []string{strconv.FormatInt(source.ID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	sourceRows, _ := m.Records(ctx, source.ID)
	// Populate the target well past the old first-page limit without widening
	// the source page; only the final referenced row needs to be copied.
	m.mu.Lock()
	var tail int64
	for i := 0; i < 100050; i++ {
		tail = m.id()
		m.b.records = append(m.b.records, Record{ID: tail, BaseID: target.ID, Position: float64(tail), Cells: map[string]json.RawMessage{}})
	}
	m.links[[2]int64{forward.ID, sourceRows[0].ID}] = []int64{tail}
	m.links[[2]int64{reverse.ID, tail}] = []int64{sourceRows[0].ID}
	m.mu.Unlock()
	err = m.WithBaseReadSnapshot(ctx, owner.ID, source.ID, func(read BaseSnapshotReader) error {
		fields, err := read.Fields(ctx, target.ID)
		if err != nil {
			return err
		}
		links, err := read.LinksForRecordsConstrained(ctx, forward.ID, []int64{sourceRows[0].ID}, target.ID, fields, nil)
		if err != nil {
			return err
		}
		if len(links[sourceRows[0].ID]) != 1 || links[sourceRows[0].ID][0] != tail {
			t.Fatalf("forward tail: %v", links)
		}
		rows, err := read.RecordsConstrainedByIDs(ctx, target.ID, []int64{tail}, fields, nil)
		if err != nil {
			return err
		}
		if len(rows) != 1 || rows[0].ID != tail {
			t.Fatalf("tail row: %v", rows)
		}
		back, err := read.LinksToRecordsConstrained(ctx, reverse.ID, []int64{sourceRows[0].ID}, target.ID, fields, nil)
		if err != nil {
			return err
		}
		if len(back[sourceRows[0].ID]) != 1 || back[sourceRows[0].ID][0] != tail {
			t.Fatalf("reverse tail: %v", back)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMemoryBaseSnapshotLargeSourceKeepsFirstAuthorizedPage(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	owner, ws, _ := m.CreateUser(ctx, "owner@example.test", "Owner", "")
	base, err := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Source")
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	for i := 0; i < 100050; i++ {
		id := m.id()
		m.b.records = append(m.b.records, Record{ID: id, BaseID: base.ID, Position: float64(id), Cells: map[string]json.RawMessage{}})
	}
	m.mu.Unlock()
	err = m.WithBaseReadSnapshot(ctx, owner.ID, base.ID, func(read BaseSnapshotReader) error {
		fields, err := read.Fields(ctx, base.ID)
		if err != nil {
			return err
		}
		rows, err := read.QueryRecordsConstrained(ctx, base.ID, fields, nil, btquery.Config{}, 10000)
		if err != nil {
			return err
		}
		if len(rows) != 10000 {
			t.Fatalf("source page length=%d", len(rows))
		}
		if _, err := read.QueryRecordsConstrained(ctx, base.ID, fields, nil, btquery.Config{Sorts: []btquery.Sort{{F: fields[0].ID, Asc: true}}}, 10000); err == nil {
			t.Fatal("sparse snapshot unexpectedly accepted a different query")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMemoryBaseSnapshotIgnoresInvisibleLinkFanout(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	owner, ws, _ := m.CreateUser(ctx, "owner@example.test", "Owner", "")
	guest, _, _ := m.CreateUser(ctx, "guest@example.test", "Guest", "")
	source, _ := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Source")
	target, _ := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Target")
	_ = m.SetShare(ctx, source.ID, guest.ID, RoleView)
	_ = m.SetShare(ctx, target.ID, guest.ID, RoleView)
	forward, _ := m.AddField(ctx, Field{BaseID: source.ID, Name: "forward", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}})
	targetFields, _ := m.Fields(ctx, target.ID)
	targetRows, _ := m.Records(ctx, target.ID)
	sourceRows, _ := m.Records(ctx, source.ID)
	key := strconv.FormatInt(targetFields[0].ID, 10)
	_, _ = m.SetCells(ctx, target.ID, targetRows[0].ID, map[string]json.RawMessage{key: json.RawMessage(`"visible"`)})
	_, _ = m.SetCells(ctx, target.ID, targetRows[1].ID, map[string]json.RawMessage{key: json.RawMessage(`"hidden"`)})
	// More than the output edge budget of distinct hidden targets must not
	// consume that budget or require an O(edges × records) cold lookup.
	links := make([]int64, 0, 100002)
	m.mu.Lock()
	for i := 0; i < 100001; i++ {
		id := m.id()
		m.b.records = append(m.b.records, Record{ID: id, BaseID: target.ID, Position: float64(id), Cells: map[string]json.RawMessage{key: json.RawMessage(`"hidden"`)}})
		links = append(links, id)
	}
	m.mu.Unlock()
	links = append(links, targetRows[0].ID)
	if err := m.SetLinks(ctx, source.ID, forward.ID, sourceRows[0].ID, links); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(btquery.Config{Locked: true, Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: targetFields[0].ID, Op: "is", V: "visible"}}}})
	if _, err := m.AddView(ctx, View{BaseID: target.ID, Type: "grid", Name: "Restricted", Config: config}); err != nil {
		t.Fatal(err)
	}
	err := m.WithBaseReadSnapshot(ctx, guest.ID, source.ID, func(read BaseSnapshotReader) error {
		fields, err := read.Fields(ctx, target.ID)
		if err != nil {
			return err
		}
		views, err := read.Views(ctx, target.ID)
		if err != nil {
			return err
		}
		var mandatory []btquery.Config
		for _, view := range views {
			var cfg btquery.Config
			if err := json.Unmarshal(view.Config, &cfg); err != nil {
				return err
			}
			if cfg.Locked {
				mandatory = append(mandatory, cfg)
			}
		}
		got, err := read.LinksForRecordsConstrained(ctx, forward.ID, []int64{sourceRows[0].ID}, target.ID, fields, mandatory)
		if err != nil {
			return err
		}
		if len(got[sourceRows[0].ID]) != 1 || got[sourceRows[0].ID][0] != targetRows[0].ID {
			t.Fatalf("visible links: %v", got)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMemoryBaseSnapshotIgnoresHiddenReverseBasesBeforeTableBudget(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	owner, ws, _ := m.CreateUser(ctx, "owner@example.test", "Owner", "")
	guest, _, _ := m.CreateUser(ctx, "guest@example.test", "Guest", "")
	source, err := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Source")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.SetShare(ctx, source.ID, guest.ID, RoleView); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < memoryBaseSnapshotMaxTables+1; i++ {
		other, err := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Other")
		if err != nil {
			t.Fatal(err)
		}
		if err := m.SetShare(ctx, other.ID, guest.ID, RoleView); err != nil {
			t.Fatal(err)
		}
		link, err := m.AddField(ctx, Field{BaseID: other.ID, Name: "hidden reverse", Type: "link", Options: []string{strconv.FormatInt(source.ID, 10)}})
		if err != nil {
			t.Fatal(err)
		}
		cfg, _ := json.Marshal(btquery.Config{Locked: true, Hidden: []int64{link.ID}})
		if _, err := m.AddView(ctx, View{BaseID: other.ID, Type: "grid", Name: "restricted", Config: cfg}); err != nil {
			t.Fatal(err)
		}
	}
	err = m.WithBaseReadSnapshot(ctx, guest.ID, source.ID, func(read BaseSnapshotReader) error {
		refs, err := read.LinkFieldsTargeting(ctx, source.ID)
		if err != nil {
			return err
		}
		if len(refs) != 0 {
			t.Fatalf("hidden reverse fields leaked: %v", refs)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMemoryBaseSnapshotOnlyCopiesReferencedTargetMemberNames(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	sourceOwner, sourceWS, _ := m.CreateUser(ctx, "source@example.test", "Source owner", "source-secret")
	targetOwner, targetWS, _ := m.CreateUser(ctx, "target@example.test", "Target owner", "target-secret")
	other, _, _ := m.CreateUser(ctx, "other@example.test", "Other member", "other-secret")
	guest, _, _ := m.CreateUser(ctx, "guest@example.test", "Guest", "guest-secret")
	m.mu.Lock()
	m.members[other.ID] = append(m.members[other.ID], targetWS.ID)
	m.mu.Unlock()
	source, err := m.CreateInitializedBase(ctx, sourceWS.ID, sourceOwner.ID, nil, "Source")
	if err != nil {
		t.Fatal(err)
	}
	target, err := m.CreateInitializedBase(ctx, targetWS.ID, targetOwner.ID, nil, "Target")
	if err != nil {
		t.Fatal(err)
	}
	_ = m.SetShare(ctx, source.ID, guest.ID, RoleView)
	_ = m.SetShare(ctx, target.ID, guest.ID, RoleView)
	link, _ := m.AddField(ctx, Field{BaseID: source.ID, Name: "Link", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}})
	person, _ := m.AddField(ctx, Field{BaseID: target.ID, Name: "Person", Type: "person"})
	sourceRows, _ := m.Records(ctx, source.ID)
	targetRows, _ := m.Records(ctx, target.ID)
	if _, err := m.SetCells(ctx, target.ID, targetRows[0].ID, map[string]json.RawMessage{strconv.FormatInt(person.ID, 10): json.RawMessage(strconv.FormatInt(targetOwner.ID, 10))}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetLinks(ctx, source.ID, link.ID, sourceRows[0].ID, []int64{targetRows[0].ID}); err != nil {
		t.Fatal(err)
	}
	err = m.WithBaseReadSnapshot(ctx, guest.ID, source.ID, func(read BaseSnapshotReader) error {
		names, err := read.VisibleMemberNames(ctx, targetWS.ID, []int64{targetOwner.ID, other.ID})
		if err != nil {
			return err
		}
		if names[targetOwner.ID] != "Target owner" || len(names) != 1 {
			t.Fatalf("target names=%v", names)
		}
		members, err := read.WorkspaceMembers(ctx, sourceWS.ID)
		if err != nil {
			return err
		}
		for _, member := range members {
			if member.PasswordHash != "" {
				t.Fatal("password copied into snapshot")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMemoryBaseSnapshotKeepsOnlyNeededHiddenCells(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	owner, ws, _ := m.CreateUser(ctx, "owner@example.test", "Owner", "")
	guest, _, _ := m.CreateUser(ctx, "guest@example.test", "Guest", "")
	base, _ := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Source")
	_ = m.SetShare(ctx, base.ID, guest.ID, RoleView)
	ruleField, _ := m.AddField(ctx, Field{BaseID: base.ID, Name: "Policy", Type: "text"})
	extraField, _ := m.AddField(ctx, Field{BaseID: base.ID, Name: "Hidden content", Type: "text"})
	rows, _ := m.Records(ctx, base.ID)
	ruleKey, extraKey := strconv.FormatInt(ruleField.ID, 10), strconv.FormatInt(extraField.ID, 10)
	_, _ = m.SetCells(ctx, base.ID, rows[0].ID, map[string]json.RawMessage{ruleKey: json.RawMessage(`"allow"`), extraKey: json.RawMessage(`"not needed"`)})
	cfg := btquery.Config{Locked: true, Hidden: []int64{ruleField.ID, extraField.ID}, Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: ruleField.ID, Op: "is", V: "allow"}}}}
	raw, _ := json.Marshal(cfg)
	if _, err := m.AddView(ctx, View{BaseID: base.ID, Type: "grid", Name: "restricted", Config: raw}); err != nil {
		t.Fatal(err)
	}
	err := m.WithBaseReadSnapshot(ctx, guest.ID, base.ID, func(read BaseSnapshotReader) error {
		fields, err := read.Fields(ctx, base.ID)
		if err != nil {
			return err
		}
		views, err := read.Views(ctx, base.ID)
		if err != nil {
			return err
		}
		var mandatory []btquery.Config
		for _, view := range views {
			var c btquery.Config
			if err := json.Unmarshal(view.Config, &c); err != nil {
				return err
			}
			if c.Locked {
				mandatory = append(mandatory, c)
			}
		}
		got, err := read.QueryRecordsConstrained(ctx, base.ID, fields, mandatory, btquery.Config{}, 10000)
		if err != nil {
			return err
		}
		if len(got) != 1 || string(got[0].Cells[ruleKey]) != `"allow"` {
			t.Fatalf("policy cell missing: %v", got)
		}
		if _, ok := got[0].Cells[extraKey]; ok {
			t.Fatalf("unneeded hidden cell copied: %v", got[0].Cells)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMemoryBaseSnapshotFiltersRelatedRowsBeforeCopy(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	owner, ws, _ := m.CreateUser(ctx, "owner@example.test", "Owner", "")
	guest, _, _ := m.CreateUser(ctx, "guest@example.test", "Guest", "")
	source, _ := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Source")
	target, _ := m.CreateInitializedBase(ctx, ws.ID, owner.ID, nil, "Target")
	if err := m.SetShare(ctx, source.ID, guest.ID, RoleView); err != nil {
		t.Fatal(err)
	}
	if err := m.SetShare(ctx, target.ID, guest.ID, RoleView); err != nil {
		t.Fatal(err)
	}
	forward, _ := m.AddField(ctx, Field{BaseID: source.ID, Name: "forward", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}})
	targetFields, _ := m.Fields(ctx, target.ID)
	targetRows, _ := m.Records(ctx, target.ID)
	sourceRows, _ := m.Records(ctx, source.ID)
	key := strconv.FormatInt(targetFields[0].ID, 10)
	if _, err := m.SetCells(ctx, target.ID, targetRows[0].ID, map[string]json.RawMessage{key: json.RawMessage(`"visible"`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetCells(ctx, target.ID, targetRows[1].ID, map[string]json.RawMessage{key: json.RawMessage(`"hidden"`)}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetLinks(ctx, source.ID, forward.ID, sourceRows[0].ID, []int64{targetRows[0].ID, targetRows[1].ID}); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(btquery.Config{Locked: true, Filters: &btquery.Filters{Conj: "and", Rules: []btquery.Rule{{F: targetFields[0].ID, Op: "is", V: "visible"}}}})
	if _, err := m.AddView(ctx, View{BaseID: target.ID, Type: "grid", Name: "Restricted", Config: config}); err != nil {
		t.Fatal(err)
	}
	err := m.WithBaseReadSnapshot(ctx, guest.ID, source.ID, func(read BaseSnapshotReader) error {
		fields, err := read.Fields(ctx, target.ID)
		if err != nil {
			return err
		}
		views, err := read.Views(ctx, target.ID)
		if err != nil {
			return err
		}
		var mandatory []btquery.Config
		for _, view := range views {
			var cfg btquery.Config
			if err := json.Unmarshal(view.Config, &cfg); err != nil {
				return err
			}
			if cfg.Locked {
				mandatory = append(mandatory, cfg)
			}
		}
		links, err := read.LinksForRecordsConstrained(ctx, forward.ID, []int64{sourceRows[0].ID}, target.ID, fields, mandatory)
		if err != nil {
			return err
		}
		if len(links[sourceRows[0].ID]) != 1 || links[sourceRows[0].ID][0] != targetRows[0].ID {
			t.Fatalf("visible links: %v", links)
		}
		rows, err := read.RecordsConstrainedByIDs(ctx, target.ID, []int64{targetRows[0].ID, targetRows[1].ID}, fields, mandatory)
		if err != nil {
			return err
		}
		if len(rows) != 1 || rows[0].ID != targetRows[0].ID {
			t.Fatalf("visible rows: %v", rows)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
