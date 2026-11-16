package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

// afterSnapshotStore permits a deterministic write after the response data
// was read, but before the handler checks current permissions and sends it.
type afterSnapshotStore struct {
	store.Store
	once atomic.Bool
	hook func()
}

func (s *afterSnapshotStore) WithBaseReadSnapshot(ctx context.Context, uid, id int64, fn func(store.BaseSnapshotReader) error) error {
	return s.Store.WithBaseReadSnapshot(ctx, uid, id, func(reader store.BaseSnapshotReader) error {
		if err := fn(reader); err != nil {
			return err
		}
		if s.hook != nil && s.once.CompareAndSwap(false, true) {
			s.hook()
		}
		return nil
	})
}

func TestBaseSnapshotKeepsRecordsAndHeadAtSamePoint(t *testing.T) {
	checkBaseSnapshotKeepsRecordsAndHeadAtSamePoint(t, store.NewMemory())
}

func checkBaseSnapshotKeepsRecordsAndHeadAtSamePoint(t *testing.T, st store.Store) {
	wrapped := &afterSnapshotStore{Store: st}
	f := newBaseSecurityFixtureWithStore(t, wrapped)
	ctx := context.Background()
	before, err := st.BtHead(ctx, f.base.ID)
	if err != nil {
		t.Fatal(err)
	}
	wrapped.hook = func() {
		key := strconv.FormatInt(f.status.ID, 10)
		if _, err := st.SetCells(ctx, f.base.ID, f.public.ID, map[string]json.RawMessage{key: json.RawMessage(`"changed"`)}); err != nil {
			t.Error(err)
		}
		if _, err := st.AppendBtEvent(ctx, f.base.ID, json.RawMessage(`{"kind":"reload"}`)); err != nil {
			t.Error(err)
		}
	}
	r := cGet(t, f.owner, f.url)
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("GET status=%d", r.StatusCode)
	}
	var got struct {
		Records []store.Record `json:"records"`
		Head    int64          `json:"head"`
	}
	if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Head != before {
		t.Fatalf("snapshot head=%d, expected %d", got.Head, before)
	}
	for _, rec := range got.Records {
		if rec.ID == f.public.ID {
			if string(rec.Cells[strconv.FormatInt(f.status.ID, 10)]) != `"公开"` {
				t.Fatal("snapshot returned new row with old head")
			}
			return
		}
	}
	t.Fatal("snapshot missing original row")
}

func TestBaseSnapshotRejectsRowThatLosesVisibilityBeforeResponse(t *testing.T) {
	checkBaseSnapshotRejectsRowThatLosesVisibilityBeforeResponse(t, store.NewMemory())
}

func checkBaseSnapshotRejectsRowThatLosesVisibilityBeforeResponse(t *testing.T, st store.Store) {
	wrapped := &afterSnapshotStore{Store: st}
	f := newBaseSecurityFixtureWithStore(t, wrapped)
	setLockedFixture(t, f)
	wrapped.hook = func() {
		_, err := st.SetCells(context.Background(), f.base.ID, f.public.ID, map[string]json.RawMessage{strconv.FormatInt(f.status.ID, 10): json.RawMessage(`"机密"`)})
		if err != nil {
			t.Error(err)
		}
	}
	r := cGet(t, f.guest, f.url)
	defer r.Body.Close()
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("stale row response=%d", r.StatusCode)
	}
}

func TestBaseSnapshotRejectsTargetThatLosesVisibilityBeforeResponse(t *testing.T) {
	checkBaseSnapshotRejectsTargetThatLosesVisibilityBeforeResponse(t, store.NewMemory())
}

func checkBaseSnapshotRejectsTargetThatLosesVisibilityBeforeResponse(t *testing.T, st store.Store) {
	wrapped := &afterSnapshotStore{Store: st}
	f := newBaseSecurityFixtureWithStore(t, wrapped)
	ctx := context.Background()
	target, err := st.CreateInitializedBase(ctx, f.base.WorkspaceID, f.base.CreatorID, nil, "Target")
	if err != nil {
		t.Fatal(err)
	}
	status, err := st.AddField(ctx, store.Field{BaseID: target.ID, Name: "状态", Type: "text"})
	if err != nil {
		t.Fatal(err)
	}
	row, err := st.AddRecord(ctx, store.Record{BaseID: target.ID, Cells: map[string]json.RawMessage{strconv.FormatInt(status.ID, 10): json.RawMessage(`"公开"`)}})
	if err != nil {
		t.Fatal(err)
	}
	views, err := st.Views(ctx, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	views[0].Config = json.RawMessage(fmt.Sprintf(`{"locked":true,"filters":{"conj":"and","rules":[{"f":%d,"op":"is","v":"公开"}]}}`, status.ID))
	if _, err := st.UpdateView(ctx, views[0]); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, target.ID, 2, store.RoleView); err != nil {
		t.Fatal(err)
	}
	link, err := st.AddField(ctx, store.Field{BaseID: f.base.ID, Name: "关联", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinks(ctx, f.base.ID, link.ID, f.public.ID, []int64{row.ID}); err != nil {
		t.Fatal(err)
	}
	wrapped.hook = func() {
		_, err := st.SetCells(ctx, target.ID, row.ID, map[string]json.RawMessage{strconv.FormatInt(status.ID, 10): json.RawMessage(`"机密"`)})
		if err != nil {
			t.Error(err)
		}
	}
	r := cGet(t, f.guest, f.url)
	defer r.Body.Close()
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("stale target response=%d", r.StatusCode)
	}
}

func TestBaseSnapshotIncludesAuthorizedLinkBeyondFirstPage(t *testing.T) {
	checkBaseSnapshotIncludesAuthorizedLinkBeyondFirstPage(t, store.NewMemory())
}

func TestBaseSnapshotPersonPrimaryUsesOnlyWorkspaceMemberNames(t *testing.T) {
	checkBaseSnapshotPersonPrimaryUsesOnlyWorkspaceMemberNames(t, store.NewMemory())
}

func checkBaseSnapshotPersonPrimaryUsesOnlyWorkspaceMemberNames(t *testing.T, st store.Store) {
	f := newBaseSecurityFixtureWithStore(t, st)
	ctx := context.Background()
	target, err := st.CreateInitializedBase(ctx, f.base.WorkspaceID, f.base.CreatorID, nil, "Target")
	if err != nil {
		t.Fatal(err)
	}
	fields, err := st.Fields(ctx, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	fields[0].Type = "person"
	if _, err := st.UpdateField(ctx, fields[0]); err != nil {
		t.Fatal(err)
	}
	fieldID := strconv.FormatInt(fields[0].ID, 10)
	inside, err := st.AddRecord(ctx, store.Record{BaseID: target.ID, Cells: map[string]json.RawMessage{fieldID: json.RawMessage(`1`)}})
	if err != nil {
		t.Fatal(err)
	}
	outside, err := st.AddRecord(ctx, store.Record{BaseID: target.ID, Cells: map[string]json.RawMessage{fieldID: json.RawMessage(`2`)}})
	if err != nil {
		t.Fatal(err)
	}
	link, err := st.AddField(ctx, store.Field{BaseID: f.base.ID, Name: "关联", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinks(ctx, f.base.ID, link.ID, f.public.ID, []int64{inside.ID, outside.ID}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, target.ID, 2, store.RoleView); err != nil {
		t.Fatal(err)
	}
	r := cGet(t, f.guest, f.url)
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("GET status=%d", r.StatusCode)
	}
	var got struct {
		Expansions map[string]json.RawMessage `json:"expansions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	var titles map[string]string
	if err := json.Unmarshal(got.Expansions[strconv.FormatInt(link.ID, 10)+":titles"], &titles); err != nil {
		t.Fatal(err)
	}
	if titles[strconv.FormatInt(inside.ID, 10)] != "Owner" {
		t.Fatalf("member title missing: %+v", titles)
	}
	if _, ok := titles[strconv.FormatInt(outside.ID, 10)]; ok {
		t.Fatal("non-member name or ID leaked as title")
	}
}

func TestBaseSnapshotCrossWorkspacePrimaryMemberTitles(t *testing.T) {
	checkBaseSnapshotCrossWorkspacePrimaryMemberTitles(t, store.NewMemory())
}

func checkBaseSnapshotCrossWorkspacePrimaryMemberTitles(t *testing.T, st store.Store) {
	for _, kind := range []string{"person", "created_by"} {
		t.Run(kind, func(t *testing.T) {
			// Every subtest uses a fresh database so user/workspace IDs are stable.
			var db store.Store
			if _, ok := st.(*store.Memory); ok {
				db = store.NewMemory()
			} else {
				db = postgresBaseSecurityStore(t)
			}
			f := newBaseSecurityFixtureWithStore(t, db)
			ctx := context.Background()
			target, err := db.CreateInitializedBase(ctx, 2, 2, nil, "Guest target")
			if err != nil {
				t.Fatal(err)
			}
			fields, err := db.Fields(ctx, target.ID)
			if err != nil {
				t.Fatal(err)
			}
			fields[0].Type = kind
			if _, err := db.UpdateField(ctx, fields[0]); err != nil {
				t.Fatal(err)
			}
			creator := int64(2)
			row, err := db.AddRecord(ctx, store.Record{BaseID: target.ID, CreatorID: &creator, Cells: map[string]json.RawMessage{strconv.FormatInt(fields[0].ID, 10): json.RawMessage(`2`)}})
			if err != nil {
				t.Fatal(err)
			}
			link, err := db.AddField(ctx, store.Field{BaseID: f.base.ID, Name: "跨空间关联", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}})
			if err != nil {
				t.Fatal(err)
			}
			if err := db.SetLinks(ctx, f.base.ID, link.ID, f.public.ID, []int64{row.ID}); err != nil {
				t.Fatal(err)
			}
			// Without a target share, no target record ID or name may be returned.
			read := func() map[string]string {
				r := cGet(t, f.owner, f.url)
				defer r.Body.Close()
				if r.StatusCode != http.StatusOK {
					t.Fatalf("GET status=%d", r.StatusCode)
				}
				var got struct {
					Expansions map[string]json.RawMessage `json:"expansions"`
				}
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Fatal(err)
				}
				var titles map[string]string
				if err := json.Unmarshal(got.Expansions[strconv.FormatInt(link.ID, 10)+":titles"], &titles); err != nil {
					t.Fatal(err)
				}
				return titles
			}
			if titles := read(); len(titles) != 0 {
				t.Fatalf("unshared target leaked: %+v", titles)
			}
			if err := db.SetShare(ctx, target.ID, 1, store.RoleView); err != nil {
				t.Fatal(err)
			}
			if titles := read(); titles[strconv.FormatInt(row.ID, 10)] != "Guest" {
				t.Fatalf("cross workspace title=%+v", titles)
			}
		})
	}
}

func checkBaseSnapshotIncludesAuthorizedLinkBeyondFirstPage(t *testing.T, st store.Store) {
	f := newBaseSecurityFixtureWithStore(t, st)
	ctx := context.Background()
	target, err := st.CreateInitializedBase(ctx, f.base.WorkspaceID, f.base.CreatorID, nil, "Target")
	if err != nil {
		t.Fatal(err)
	}
	fields, err := st.Fields(ctx, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	key := strconv.FormatInt(fields[0].ID, 10)
	rows := make([]store.Record, 10001)
	for i := range rows {
		rows[i] = store.Record{BaseID: target.ID, Cells: map[string]json.RawMessage{key: json.RawMessage(fmt.Sprintf(`"row-%d"`, i))}}
	}
	if err := st.AddRecordsBulk(ctx, target.ID, rows); err != nil {
		t.Fatal(err)
	}
	last, err := st.AddRecord(ctx, store.Record{BaseID: target.ID, Cells: map[string]json.RawMessage{key: json.RawMessage(`"tail-after-page"`)}})
	if err != nil {
		t.Fatal(err)
	}
	link, err := st.AddField(ctx, store.Field{BaseID: f.base.ID, Name: "关联", Type: "link", Options: []string{strconv.FormatInt(target.ID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinks(ctx, f.base.ID, link.ID, f.public.ID, []int64{last.ID}); err != nil {
		t.Fatal(err)
	}
	reverseField, err := st.AddField(ctx, store.Field{BaseID: target.ID, Name: "反向关联", Type: "link", Options: []string{strconv.FormatInt(f.base.ID, 10)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinks(ctx, target.ID, reverseField.ID, last.ID, []int64{f.public.ID}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, target.ID, 2, store.RoleView); err != nil {
		t.Fatal(err)
	}
	r := cGet(t, f.guest, f.url)
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("GET status=%d", r.StatusCode)
	}
	var got struct {
		Expansions map[string]json.RawMessage `json:"expansions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	var titles map[string]string
	if err := json.Unmarshal(got.Expansions[strconv.FormatInt(link.ID, 10)+":titles"], &titles); err != nil {
		t.Fatal(err)
	}
	if titles[strconv.FormatInt(last.ID, 10)] != "tail-after-page" {
		t.Fatalf("target title beyond page missing: %+v", titles)
	}
	var reverse []struct {
		SourceBase int64              `json:"sourceBase"`
		FieldID    int64              `json:"fieldId"`
		From       map[string][]int64 `json:"from"`
	}
	if err := json.Unmarshal(got.Expansions["reverse"], &reverse); err != nil {
		t.Fatal(err)
	}
	for _, item := range reverse {
		if item.SourceBase == target.ID && item.FieldID == reverseField.ID {
			ids := item.From[strconv.FormatInt(f.public.ID, 10)]
			if len(ids) != 1 || ids[0] != last.ID {
				t.Fatalf("reverse target=%v", ids)
			}
			return
		}
	}
	t.Fatal("reverse association beyond page missing")
}

func TestPostgresBaseSnapshotAPI(t *testing.T) {
	t.Run("head and records", func(t *testing.T) { checkBaseSnapshotKeepsRecordsAndHeadAtSamePoint(t, postgresBaseSecurityStore(t)) })
	t.Run("row visibility", func(t *testing.T) {
		checkBaseSnapshotRejectsRowThatLosesVisibilityBeforeResponse(t, postgresBaseSecurityStore(t))
	})
	t.Run("target visibility", func(t *testing.T) {
		checkBaseSnapshotRejectsTargetThatLosesVisibilityBeforeResponse(t, postgresBaseSecurityStore(t))
	})
	t.Run("associated row beyond page", func(t *testing.T) {
		checkBaseSnapshotIncludesAuthorizedLinkBeyondFirstPage(t, postgresBaseSecurityStore(t))
	})
	t.Run("person primary", func(t *testing.T) {
		checkBaseSnapshotPersonPrimaryUsesOnlyWorkspaceMemberNames(t, postgresBaseSecurityStore(t))
	})
	t.Run("cross workspace names", func(t *testing.T) {
		checkBaseSnapshotCrossWorkspacePrimaryMemberTitles(t, postgresBaseSecurityStore(t))
	})
}
