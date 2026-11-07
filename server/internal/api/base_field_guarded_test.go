package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"sync"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestConvertCellRetainsAlreadyCompatibleValues(t *testing.T) {
	for _, tc := range []struct {
		from, to string
		value    json.RawMessage
	}{
		{"text", "email", json.RawMessage(`"a@example.test"`)},
		{"text", "url", json.RawMessage(`"https://example.test"`)},
		{"text", "phone", json.RawMessage(`"+86 123-456"`)},
		{"number", "rating", json.RawMessage(`3`)},
	} {
		if got := convertCell(store.Field{Type: tc.from}, store.Field{Type: tc.to}, tc.value); string(got) != string(tc.value) {
			t.Errorf("%s -> %s: got %s, want %s", tc.from, tc.to, got, tc.value)
		}
	}
}

type revokeBeforeFieldStore struct {
	store.Store
	mu     sync.Mutex
	before func()
}

func (s *revokeBeforeFieldStore) MutateFieldGuarded(ctx context.Context, guard store.BaseWriteGuard, change store.FieldMutation) (store.FieldMutationResult, error) {
	s.mu.Lock()
	fn := s.before
	s.before = nil
	s.mu.Unlock()
	if fn != nil {
		fn()
	}
	return s.Store.MutateFieldGuarded(ctx, guard, change)
}

func TestFieldMutationRechecksRevocation(t *testing.T) {
	underlying := store.NewMemory()
	wrapped := &revokeBeforeFieldStore{Store: underlying}
	ts, owner := newTestServer(t, wrapped, nil)
	post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "field-owner@example.test", "name": "Owner", "password": "password123"})
	jar, _ := cookiejar.New(nil)
	guest := &http.Client{Jar: jar}
	post(t, guest, ts.URL+"/api/auth/register", map[string]string{"email": "field-guest@example.test", "name": "Guest", "password": "password123"})
	var base store.DocMeta
	if err := json.NewDecoder(post(t, owner, ts.URL+"/api/bases", nil).Body).Decode(&base); err != nil {
		t.Fatal(err)
	}
	if err := underlying.SetShare(context.Background(), base.ID, 2, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	wrapped.mu.Lock()
	wrapped.before = func() {
		if err := underlying.SetShare(context.Background(), base.ID, 2, ""); err != nil {
			t.Error(err)
		}
	}
	wrapped.mu.Unlock()
	res := post(t, guest, ts.URL+"/api/bases/"+strconv.FormatInt(base.ID, 10)+"/fields", map[string]any{"name": "不能创建", "type": "text"})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("revoked status=%d", res.StatusCode)
	}
	fields, err := underlying.Fields(context.Background(), base.ID)
	if err != nil || len(fields) != 1 || fields[0].Name != "文本" {
		t.Fatalf("unauthorized mutation: fields=%+v err=%v", fields, err)
	}
}
