package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func newTestServer(t *testing.T, st store.Store, now func() time.Time) (*httptest.Server, *http.Client) {
	t.Helper()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1000, Now: now}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	jar, _ := cookiejar.New(nil)
	return ts, &http.Client{Jar: jar}
}

func post(t *testing.T, c *http.Client, url string, body any) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	res, err := c.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestAuthFlow(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)

	res, _ := c.Get(ts.URL + "/api/me")
	if res.StatusCode != 401 {
		t.Fatalf("me before login: %d", res.StatusCode)
	}

	res = post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "kay@example.com", "name": "Kay", "password": "password123"})
	if res.StatusCode != 201 {
		t.Fatalf("register: %d", res.StatusCode)
	}
	var me meResponse
	_ = json.NewDecoder(res.Body).Decode(&me)
	if me.User.Email != "kay@example.com" || len(me.Workspaces) != 1 {
		t.Fatalf("unexpected register body %+v", me)
	}
	for _, ck := range res.Cookies() {
		if ck.Name == CookieName && (!ck.HttpOnly || ck.SameSite != http.SameSiteLaxMode) {
			t.Fatal("cookie flags")
		}
	}

	res, _ = c.Get(ts.URL + "/api/me")
	if res.StatusCode != 200 {
		t.Fatalf("me after register: %d", res.StatusCode)
	}

	if res = post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "KAY@example.com", "name": "K", "password": "password123"}); res.StatusCode != 409 {
		t.Fatalf("duplicate register: %d", res.StatusCode)
	}

	if res = post(t, c, ts.URL+"/api/auth/logout", nil); res.StatusCode != 204 {
		t.Fatalf("logout: %d", res.StatusCode)
	}
	if res, _ = c.Get(ts.URL + "/api/me"); res.StatusCode != 401 {
		t.Fatalf("me after logout: %d", res.StatusCode)
	}

	if res = post(t, c, ts.URL+"/api/auth/login", map[string]string{"email": "kay@example.com", "password": "nope-nope"}); res.StatusCode != 401 {
		t.Fatalf("bad login: %d", res.StatusCode)
	}
	if res = post(t, c, ts.URL+"/api/auth/login", map[string]string{"email": "kay@example.com", "password": "password123"}); res.StatusCode != 200 {
		t.Fatalf("login: %d", res.StatusCode)
	}
	if res, _ = c.Get(ts.URL + "/api/me"); res.StatusCode != 200 {
		t.Fatalf("me after login: %d", res.StatusCode)
	}
}

func TestValidationAndCSRF(t *testing.T) {
	ts, c := newTestServer(t, store.NewMemory(), nil)
	cases := []struct {
		body map[string]string
		code int
	}{
		{map[string]string{"email": "bad", "name": "a", "password": "password123"}, 400},
		{map[string]string{"email": "a@b.co", "name": "a", "password": "short"}, 400},
		{map[string]string{"email": "a@b.co", "name": "", "password": "password123"}, 400},
	}
	for _, tc := range cases {
		if res := post(t, c, ts.URL+"/api/auth/register", tc.body); res.StatusCode != tc.code {
			t.Fatalf("%v: got %d", tc.body, res.StatusCode)
		}
	}
	res, _ := c.Post(ts.URL+"/api/auth/login", "application/x-www-form-urlencoded", bytes.NewBufferString("email=a"))
	if res.StatusCode != 415 {
		t.Fatalf("form post should be rejected: %d", res.StatusCode)
	}
	res, _ = c.Get(ts.URL + "/api/nope")
	if res.StatusCode != 404 || res.Header.Get("X-Request-Id") == "" || res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("middleware headers missing: %d", res.StatusCode)
	}
	res, _ = c.Get(ts.URL + "/healthz")
	if res.StatusCode != 200 {
		t.Fatalf("healthz: %d", res.StatusCode)
	}
}

func TestSessionExpiry(t *testing.T) {
	now := time.Now()
	ts, c := newTestServer(t, store.NewMemory(), func() time.Time { return now })
	post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "e@x.io", "name": "E", "password": "password123"})
	now = now.Add(2 * time.Hour)
	if res, _ := c.Get(ts.URL + "/api/me"); res.StatusCode != 401 {
		t.Fatalf("expired session accepted: %d", res.StatusCode)
	}
}
