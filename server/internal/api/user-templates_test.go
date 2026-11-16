package api

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"strings"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestUserTemplatesArePrivate(t *testing.T) {
	ts, a := newTestServer(t, store.NewMemory(), nil)
	post(t, a, ts.URL+"/api/auth/register", map[string]string{"email": "tpl-a@example.test", "name": "A", "password": "password123"})
	jar, _ := cookiejar.New(nil)
	b := &http.Client{Jar: jar}
	post(t, b, ts.URL+"/api/auth/register", map[string]string{"email": "tpl-b@example.test", "name": "B", "password": "password123"})
	res := post(t, a, ts.URL+"/api/me/templates", map[string]string{"name": "周报", "body": "## 本周\n\n- 事项"})
	var created store.UserTemplate
	json.NewDecoder(res.Body).Decode(&created)
	if res.StatusCode != http.StatusCreated || created.ID == 0 {
		t.Fatalf("create status=%d", res.StatusCode)
	}
	if res := post(t, a, ts.URL+"/api/me/templates", map[string]string{"name": "", "body": "x"}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty name status=%d", res.StatusCode)
	}
	if res := post(t, a, ts.URL+"/api/me/templates", map[string]string{"name": "大", "body": strings.Repeat("x", maxTemplateBody+1)}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("big body status=%d", res.StatusCode)
	}
	var list struct{ Templates []store.UserTemplate }
	json.NewDecoder(send(t, b, "GET", ts.URL+"/api/me/templates", nil).Body).Decode(&list)
	if len(list.Templates) != 0 {
		t.Fatalf("other user sees %+v", list.Templates)
	}
	path := ts.URL + "/api/me/templates/" + strconv.FormatInt(created.ID, 10)
	if res := send(t, b, "DELETE", path, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("foreign delete status=%d", res.StatusCode)
	}
	json.NewDecoder(send(t, a, "GET", ts.URL+"/api/me/templates", nil).Body).Decode(&list)
	if len(list.Templates) != 1 || list.Templates[0].Name != "周报" {
		t.Fatalf("own list=%+v", list.Templates)
	}
	if res := send(t, a, "DELETE", path, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status=%d", res.StatusCode)
	}
}
