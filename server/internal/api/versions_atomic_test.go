package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type beforeRestoreStore struct {
	store.Store
	once   sync.Once
	before func(store.RestoreGuard)
}

func (s *beforeRestoreStore) AppendRestoreOps(ctx context.Context, guard store.RestoreGuard, doc, head int64, ops []store.RawOp) ([]int64, error) {
	s.once.Do(func() { s.before(guard) })
	return s.Store.AppendRestoreOps(ctx, guard, doc, head, ops)
}

func TestRestoreRejectsConcurrentChangeAndPermissionRevocation(t *testing.T) {
	for _, scenario := range []string{"concurrent_edit", "concurrent_empty", "revoked_permission", "revoked_session"} {
		t.Run(scenario, func(t *testing.T) {
			ctx := context.Background()
			base := store.NewMemory()
			wrapper := &beforeRestoreStore{Store: base}
			ts, owner := newTestServer(t, wrapper, nil)
			jar, _ := cookiejar.New(nil)
			editor := &http.Client{Jar: jar}
			post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "restore-owner@x.test", "name": "Owner", "password": "password123"})
			post(t, editor, ts.URL+"/api/auth/register", map[string]string{"email": "restore-editor@x.test", "name": "Editor", "password": "password123"})
			var meta store.DocMeta
			if err := json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "版本"}).Body).Decode(&meta); err != nil {
				t.Fatal(err)
			}
			docURL := fmt.Sprintf("%s/api/docs/%d", ts.URL, meta.ID)
			if r := send(t, owner, "PUT", docURL+"/shares", map[string]string{"email": "restore-editor@x.test", "role": "edit"}); r.StatusCode != http.StatusOK {
				t.Fatal(r.StatusCode)
			}
			server := &Server{Store: base}
			seedDoc(t, server, meta.ID, "原版本")
			if r := post(t, owner, docURL+"/versions", map[string]string{"label": "原版"}); r.StatusCode != http.StatusCreated {
				t.Fatal(r.StatusCode)
			}
			versions, err := base.Versions(ctx, meta.ID)
			if err != nil || len(versions) != 1 {
				t.Fatalf("versions: %+v %v", versions, err)
			}
			if scenario != "concurrent_empty" {
				seedDoc(t, server, meta.ID, "当前内容")
			}
			before, err := base.Head(ctx, meta.ID)
			if err != nil {
				t.Fatal(err)
			}
			hookResult := make(chan error, 1)
			if scenario == "concurrent_edit" || scenario == "concurrent_empty" {
				replica, _, err := StateAtHead(ctx, base, meta.ID)
				if err != nil {
					t.Fatal(err)
				}
				paragraph := collab.OpID{Client: 0, Clock: 2}
				op := replica.InsertText(999, paragraph, len([]rune(replica.Text(paragraph))), "并发")
				encoded, err := collab.EncodeOps([]collab.Op{op})
				if err != nil {
					t.Fatal(err)
				}
				wrapper.before = func(_ store.RestoreGuard) {
					_, hookErr := base.AppendOps(ctx, meta.ID, []store.RawOp{{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded}})
					hookResult <- hookErr
				}
			} else if scenario == "revoked_permission" {
				u, lookupErr := base.UserByEmail(ctx, "restore-editor@x.test")
				if lookupErr != nil {
					t.Fatal(lookupErr)
				}
				wrapper.before = func(_ store.RestoreGuard) { hookResult <- base.SetShare(ctx, meta.ID, u.ID, "") }
			} else {
				wrapper.before = func(guard store.RestoreGuard) { hookResult <- base.DeleteSession(ctx, guard.SessionHash) }
			}
			r := post(t, editor, docURL+"/versions/"+strconv.FormatInt(versions[0].Seq, 10)+"/restore", nil)
			defer r.Body.Close()
			select {
			case hookErr := <-hookResult:
				if hookErr != nil {
					t.Fatal(hookErr)
				}
			default:
				t.Fatal("restore hook not reached")
			}
			var body struct{ Error, Message string }
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			wantStatus, wantCode := http.StatusConflict, "restore_conflict"
			if scenario == "revoked_permission" {
				wantStatus, wantCode = http.StatusForbidden, "forbidden"
			} else if scenario == "revoked_session" {
				wantStatus, wantCode = http.StatusUnauthorized, "unauthorized"
			}
			if r.StatusCode != wantStatus || body.Error != wantCode {
				t.Fatalf("status=%d body=%+v", r.StatusCode, body)
			}
			after, err := base.Head(ctx, meta.ID)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "concurrent_edit" || scenario == "concurrent_empty" {
				before++
			}
			if after != before {
				t.Fatalf("restore wrote partial ops: before=%d after=%d", before, after)
			}
			current, _, err := StateAtHead(ctx, base, meta.ID)
			if err != nil {
				t.Fatal(err)
			}
			text := viewText(current.View())
			if scenario == "concurrent_empty" {
				if !strings.Contains(text, "原版本并发") {
					t.Fatalf("lost concurrent content: %q", text)
				}
			} else if !strings.Contains(text, "当前内容") || strings.Contains(text, "原版本") || scenario == "concurrent_edit" && !strings.Contains(text, "并发") {
				t.Fatalf("lost content: %q", text)
			}
		})
	}
}

func TestRestoreUnrepresentableVersionDoesNotChangeDocument(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	ts, owner := newTestServer(t, st, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "restore-mark@x.test", "name": "Owner", "password": "password123"})
	var meta store.DocMeta
	if err := json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": "版本"}).Body).Decode(&meta); err != nil {
		t.Fatal(err)
	}
	doc, _, err := StateAtHead(ctx, st, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	paragraph := collab.OpID{Client: 0, Clock: 2}
	insert := doc.InsertText(9, paragraph, 0, "ABC")
	bold := "true"
	marked := collab.Op{T: collab.TMark, ID: collab.OpID{Client: 9, Clock: insert.ID.Clock + 3}, Block: paragraph, Key: "bold", Value: &bold,
		Start: collab.Anchor{Char: collab.OpID{Client: 9, Clock: insert.ID.Clock + 1}, Side: 0}, End: collab.Anchor{Char: collab.OpID{Client: 9, Clock: insert.ID.Clock + 1}, Side: 1}}
	doc.Apply(marked)
	deleted := doc.DeleteText(9, paragraph, 1, 1)
	appendBatch := func(ops []collab.Op) {
		t.Helper()
		rows := make([]store.RawOp, 0, len(ops))
		for _, op := range ops {
			encoded, err := collab.EncodeOps([]collab.Op{op})
			if err != nil {
				t.Fatal(err)
			}
			rows = append(rows, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded})
		}
		if _, err := st.AppendOps(ctx, meta.ID, rows); err != nil {
			t.Fatal(err)
		}
	}
	appendBatch(append([]collab.Op{insert, marked}, deleted...))
	head, err := st.Head(ctx, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveSnapshot(ctx, meta.ID, head, doc.EncodeState()); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveVersion(ctx, meta.ID, head, "含隐藏锚点", meta.CreatorID); err != nil {
		t.Fatal(err)
	}
	italic := "true"
	currentMark := collab.Op{T: collab.TMark, ID: collab.OpID{Client: 9, Clock: marked.ID.Clock + 2}, Block: paragraph, Key: "italic", Value: &italic,
		Start: collab.Anchor{Char: insert.ID, Side: 0}, End: collab.Anchor{Char: insert.ID, Side: 1}}
	doc.Apply(currentMark)
	appendBatch([]collab.Op{currentMark})
	before, err := st.Head(ctx, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	url := fmt.Sprintf("%s/api/docs/%d/versions/%d/restore", ts.URL, meta.ID, head)
	r := post(t, owner, url, nil)
	defer r.Body.Close()
	var body struct{ Error, Message string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != http.StatusConflict || body.Error != "restore_unrepresentable" {
		t.Fatalf("status=%d body=%+v", r.StatusCode, body)
	}
	after, err := st.Head(ctx, meta.ID)
	if err != nil || after != before {
		t.Fatalf("failed restore changed head: %d -> %d, %v", before, after, err)
	}
	current, _, err := StateAtHead(ctx, st, meta.ID)
	if err != nil || !strings.Contains(viewText(current.View()), "AC") {
		t.Fatalf("document changed: %v %v", current, err)
	}
}
