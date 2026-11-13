package api

import (
	"bytes"
	"context"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestWordImportNodeAccountBinding(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	res := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "word-node@test.dev", "name": "Test", "password": "password123"})
	res.Body.Close()
	u, err := st.UserByEmail(context.Background(), "word-node@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	create := func(account string) int {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/drive/word-import-nodes", bytes.NewBufferString(`{"kind":"doc","title":"导入文档","scope":"personal"}`))
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		r, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		return r.StatusCode
	}
	if got := create(""); got != 400 {
		t.Fatalf("missing account: %d", got)
	}
	if got := create("999999"); got != 401 {
		t.Fatalf("different account: %d", got)
	}
	if got := create(strconv64(u.ID)); got != 201 {
		t.Fatalf("correct account: %d", got)
	}
}
