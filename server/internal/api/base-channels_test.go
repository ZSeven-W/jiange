package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/btsync"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/coder/websocket"
)

type baseChannelFixture struct {
	st           store.Store
	hub          *btsync.Hub
	ts           *httptest.Server
	owner, guest *http.Client
	base         store.DocMeta
	viewer       store.User
	view         store.View
	fileID       int64
}

func newBaseChannelFixture(t *testing.T, wrap ...func(store.Store) store.Store) *baseChannelFixture {
	t.Helper()
	var st store.Store = store.NewMemory()
	if len(wrap) > 0 {
		st = wrap[0](st)
	}
	blobs := blob.NewMemory()
	hub := &btsync.Hub{Store: st, PingInterval: time.Hour}
	srv := &Server{Store: st, Blobs: blobs, BtHub: hub, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	makeClient := func(email string) (*http.Client, store.User) {
		jar, _ := cookiejar.New(nil)
		client := &http.Client{Jar: jar}
		res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": email, "name": "test", "password": "password123"})
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("register: %d", res.StatusCode)
		}
		defer res.Body.Close()
		var me meResponse
		if err := json.NewDecoder(res.Body).Decode(&me); err != nil {
			t.Fatal(err)
		}
		return client, me.User
	}
	owner, _ := makeClient("channel-owner@example.test")
	guest, viewer := makeClient("channel-guest@example.test")
	res := post(t, owner, ts.URL+"/api/bases", nil)
	defer res.Body.Close()
	var base store.DocMeta
	if err := json.NewDecoder(res.Body).Decode(&base); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(context.Background(), base.ID, viewer.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	views, err := st.Views(context.Background(), base.ID)
	if err != nil || len(views) == 0 {
		t.Fatalf("views: %v %v", views, err)
	}
	if err := blobs.Put(context.Background(), "base-private-file", "text/plain", []byte("secret")); err != nil {
		t.Fatal(err)
	}
	file, err := st.CreateFile(context.Background(), store.FileMeta{DocID: base.ID, Name: "secret.txt", Mime: "text/plain", Size: 6, ObjectKey: "base-private-file"})
	if err != nil {
		t.Fatal(err)
	}
	return &baseChannelFixture{st: st, hub: hub, ts: ts, owner: owner, guest: guest, base: base, viewer: viewer, view: views[0], fileID: file.ID}
}

type blockingBaseRecords struct {
	store.Store
	entered chan struct{}
	release chan struct{}
}

func (b *blockingBaseRecords) Records(ctx context.Context, id int64) ([]store.Record, error) {
	close(b.entered)
	select {
	case <-b.release:
		return b.Store.Records(ctx, id)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestBaseExportRechecksBeforeSending(t *testing.T) {
	var blocked *blockingBaseRecords
	f := newBaseChannelFixture(t, func(st store.Store) store.Store {
		blocked = &blockingBaseRecords{Store: st, entered: make(chan struct{}), release: make(chan struct{})}
		return blocked
	})
	result := make(chan *http.Response, 1)
	go func() {
		res, err := f.guest.Get(f.path("/export"))
		if err == nil {
			result <- res
		} else {
			result <- nil
		}
	}()
	select {
	case <-blocked.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("export did not reach records read")
	}
	f.lock(t, `{"locked":true}`)
	close(blocked.release)
	select {
	case res := <-result:
		if res == nil {
			t.Fatal("export request failed")
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("export after lock: %d", res.StatusCode)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("export did not complete")
	}
}

func TestBaseExportHonorsCopyProtection(t *testing.T) {
	f := newBaseChannelFixture(t)
	if err := f.st.SetCopyProtected(context.Background(), f.base.ID, true); err != nil {
		t.Fatal(err)
	}
	guest := send(t, f.guest, "GET", f.path("/export"), nil)
	guest.Body.Close()
	if guest.StatusCode != http.StatusForbidden {
		t.Fatalf("protected export to editor: %d", guest.StatusCode)
	}
	owner := send(t, f.owner, "GET", f.path("/export"), nil)
	owner.Body.Close()
	if owner.StatusCode != http.StatusOK {
		t.Fatalf("protected export to manager: %d", owner.StatusCode)
	}
	if err := f.st.SetCopyProtected(context.Background(), f.base.ID, false); err != nil {
		t.Fatal(err)
	}
	guest = send(t, f.guest, "GET", f.path("/export"), nil)
	guest.Body.Close()
	if guest.StatusCode != http.StatusOK {
		t.Fatalf("export after protection removed: %d", guest.StatusCode)
	}
}

func TestBaseExportRechecksCopyProtectionBeforeSending(t *testing.T) {
	var blocked *blockingBaseRecords
	f := newBaseChannelFixture(t, func(st store.Store) store.Store {
		blocked = &blockingBaseRecords{Store: st, entered: make(chan struct{}), release: make(chan struct{})}
		return blocked
	})
	result := make(chan *http.Response, 1)
	go func() {
		res, err := f.guest.Get(f.path("/export"))
		if err != nil {
			result <- nil
			return
		}
		result <- res
	}()
	select {
	case <-blocked.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("export did not reach records read")
	}
	if err := f.st.SetCopyProtected(context.Background(), f.base.ID, true); err != nil {
		t.Fatal(err)
	}
	close(blocked.release)
	select {
	case res := <-result:
		if res == nil {
			t.Fatal("export request failed")
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("export after copy protection enabled: %d", res.StatusCode)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("export did not complete")
	}
}

func (f *baseChannelFixture) lock(t *testing.T, raw string) {
	t.Helper()
	f.view.Config = json.RawMessage(raw)
	if _, err := f.st.UpdateView(context.Background(), f.view); err != nil {
		t.Fatal(err)
	}
}

func (f *baseChannelFixture) path(suffix string) string {
	return f.ts.URL + "/api/bases/" + strconv.FormatInt(f.base.ID, 10) + suffix
}

func (f *baseChannelFixture) dial(t *testing.T, client *http.Client) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	u, _ := url.Parse(f.path("/sync"))
	var cookies []string
	for _, cookie := range client.Jar.Cookies(u) {
		cookies = append(cookies, cookie.Name+"="+cookie.Value)
	}
	return websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(u.String(), "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": cookies}})
}

func TestBaseChannelsDenyLockedAndInvalidViews(t *testing.T) {
	f := newBaseChannelFixture(t)
	for _, target := range []string{f.path("/export"), f.ts.URL + "/api/files/" + strconv.FormatInt(f.fileID, 10)} {
		res := send(t, f.guest, "GET", target, nil)
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("unrestricted collaborator cannot read %s: %d", target, res.StatusCode)
		}
	}
	for _, raw := range []string{`{"locked":true}`, `{"locked":true,"filters":{"invalid":true}}`, `{"locked":`} {
		f.lock(t, raw)
		for _, tc := range []struct {
			method, url string
			body        any
		}{
			{"GET", f.path("/export"), nil},
			{"POST", f.path("/import"), map[string]any{"csv": "a\nx", "header": true}},
			{"GET", f.ts.URL + "/api/files/" + strconv.FormatInt(f.fileID, 10), nil},
		} {
			res := send(t, f.guest, tc.method, tc.url, tc.body)
			data, _ := io.ReadAll(res.Body)
			res.Body.Close()
			if res.StatusCode == http.StatusOK || strings.Contains(string(data), "secret") {
				t.Fatalf("%s %s allowed %d %s", raw, tc.url, res.StatusCode, data)
			}
		}
		ws, res, err := f.dial(t, f.guest)
		if err == nil {
			ws.CloseNow()
			t.Fatalf("restricted websocket accepted for %s", raw)
		}
		if res == nil || res.StatusCode != http.StatusForbidden {
			t.Fatalf("restricted websocket: %v %v", res, err)
		}
	}
	f.lock(t, `{"locked":true}`)
	res := send(t, f.owner, "GET", f.path("/export"), nil)
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("manager export: %d", res.StatusCode)
	}
}

func TestBaseSocketRechecksBeforeEvents(t *testing.T) {
	for _, change := range []string{"lock", "revoke", "logout"} {
		t.Run(change, func(t *testing.T) {
			f := newBaseChannelFixture(t)
			ws, _, err := f.dial(t, f.guest)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if _, _, err = ws.Read(ctx); err != nil {
				t.Fatal(err)
			} // initial hello
			switch change {
			case "lock":
				f.lock(t, `{"locked":true}`)
			case "revoke":
				if err = f.st.SetShare(context.Background(), f.base.ID, f.viewer.ID, ""); err != nil {
					t.Fatal(err)
				}
			case "logout":
				res := post(t, f.guest, f.ts.URL+"/api/auth/logout", nil)
				res.Body.Close()
			}
			if _, err := f.st.AppendBtEvent(context.Background(), f.base.ID, []byte(`{"kind":"record","record":{"secret":"must-not-leak"}}`)); err != nil {
				t.Fatal(err)
			}
			f.hub.Notify(f.base.ID)
			_, data, err := ws.Read(ctx)
			if err == nil {
				t.Fatalf("revoked client received data: %s", data)
			}
		})
	}
}
