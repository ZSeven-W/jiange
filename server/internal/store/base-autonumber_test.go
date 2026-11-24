package store_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestBaseAutonumberAndHierarchyViewStore(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	u, ws, err := st.CreateUser(ctx, "auto@example.com", "Auto", "hash")
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("session-tok"))
	if err := st.CreateSession(ctx, hash[:], u.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	guard := store.BaseWriteGuard{UserID: u.ID, SessionHash: hash[:]}
	b, err := st.CreateInitializedBase(ctx, ws.ID, u.ID, nil, "任务表")
	if err != nil {
		t.Fatal(err)
	}

	autoField, err := st.AddField(ctx, store.Field{
		BaseID:  b.ID,
		Name:    "编号",
		Type:    "autonumber",
		Options: []string{"TASK-", "4"},
	})
	if err != nil {
		t.Fatalf("AddField autonumber: %v", err)
	}
	autoKey := strconv.FormatInt(autoField.ID, 10)

	// 1. AddRecord auto-assigns 1, 2 sequentially and ignores caller spoofed value.
	r1, err := st.AddRecord(ctx, store.Record{
		BaseID: b.ID,
		Cells:  map[string]json.RawMessage{autoKey: json.RawMessage(`999`)},
	})
	if err != nil {
		t.Fatalf("AddRecord 1: %v", err)
	}
	if string(r1.Cells[autoKey]) != "1" {
		t.Fatalf("expected autonumber 1 (ignoring spoof 999), got %s", r1.Cells[autoKey])
	}
	r2, err := st.AddRecord(ctx, store.Record{BaseID: b.ID})
	if err != nil {
		t.Fatalf("AddRecord 2: %v", err)
	}
	if string(r2.Cells[autoKey]) != "2" {
		t.Fatalf("expected autonumber 2, got %s", r2.Cells[autoKey])
	}

	// 2. SetCells cannot overwrite or clear autonumber.
	updated, err := st.SetCells(ctx, b.ID, r1.ID, map[string]json.RawMessage{autoKey: json.RawMessage(`42`)})
	if err != nil {
		t.Fatalf("SetCells: %v", err)
	}
	if string(updated.Cells[autoKey]) != "1" {
		t.Fatalf("autonumber was overwritten via SetCells: %s", updated.Cells[autoKey])
	}

	// 3. MutateRecordGuarded "add" assigns 3; "update" protects autonumber.
	r3, _, err := st.MutateRecordGuarded(ctx, guard, b.ID, store.BaseRecordMutation{
		Operation: "add",
		Cells:     map[string]json.RawMessage{},
	}, func([]store.Field) error { return nil })
	if err != nil {
		t.Fatalf("MutateRecordGuarded add: %v", err)
	}
	if string(r3.Cells[autoKey]) != "3" {
		t.Fatalf("expected autonumber 3, got %s", r3.Cells[autoKey])
	}
	r3After, _, err := st.MutateRecordGuarded(ctx, guard, b.ID, store.BaseRecordMutation{
		Operation: "update",
		RecordID:  r3.ID,
		Cells:     map[string]json.RawMessage{autoKey: json.RawMessage(`null`)},
	}, func([]store.Field) error { return nil })
	if err != nil {
		t.Fatalf("MutateRecordGuarded update: %v", err)
	}
	if string(r3After.Cells[autoKey]) != "3" {
		t.Fatalf("autonumber cleared by MutateRecordGuarded update: %s", r3After.Cells[autoKey])
	}

	// 4. BatchRestoreRecordsGuarded assigns 4, 5 sequentially.
	restored, _, err := st.BatchRestoreRecordsGuarded(ctx, guard, b.ID, []store.BatchRestoreRecordInput{
		{Cells: map[string]json.RawMessage{autoKey: json.RawMessage(`1`)}},
		{Cells: map[string]json.RawMessage{}},
	}, func([]store.Field, map[string]json.RawMessage) error { return nil })
	if err != nil {
		t.Fatalf("BatchRestoreRecordsGuarded: %v", err)
	}
	if len(restored) != 2 || string(restored[0].Cells[autoKey]) != "4" || string(restored[1].Cells[autoKey]) != "5" {
		t.Fatalf("expected restored autonumbers 4 & 5, got %+v", restored)
	}

	// 5. AddRecordsBulk continues monotonically with 6, 7.
	if err := st.AddRecordsBulk(ctx, b.ID, []store.Record{{}, {}}); err != nil {
		t.Fatalf("AddRecordsBulk: %v", err)
	}
	allRecs, _ := st.Records(ctx, b.ID)
	last := allRecs[len(allRecs)-1]
	if string(last.Cells[autoKey]) != "7" {
		t.Fatalf("expected last bulk record autonumber 7, got %s", last.Cells[autoKey])
	}

	// 6. Hierarchy view + multi-level groups persist through AddViewGuarded.
	linkField, err := st.AddField(ctx, store.Field{
		BaseID:  b.ID,
		Name:    "父任务",
		Type:    "link",
		Options: []string{strconv.FormatInt(b.ID, 10)},
	})
	if err != nil {
		t.Fatalf("AddField link: %v", err)
	}
	hCfg, _ := json.Marshal(map[string]any{
		"parentField": linkField.ID,
		"groups":      []int64{autoField.ID},
		"group":       autoField.ID,
	})
	hv, err := st.AddViewGuarded(ctx, guard, store.View{
		BaseID: b.ID,
		Type:   "hierarchy",
		Name:   "层级视图",
		Config: hCfg,
	})
	if err != nil {
		t.Fatalf("AddViewGuarded hierarchy: %v", err)
	}
	if hv.Type != "hierarchy" {
		t.Fatalf("expected hierarchy view type, got %s", hv.Type)
	}
}
