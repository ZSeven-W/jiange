package api

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestPasteShareTargetDoesNotJoinLink(t *testing.T) {
	e := newCopyTestEnv(t)
	ctx := context.Background()
	link, err := e.store.ChangeLinkRole(ctx, e.source.ID, "view", "paste-share-test")
	if err != nil {
		t.Fatal(err)
	}
	read := func(uid string) (int, []byte) {
		t.Helper()
		req, _ := http.NewRequest("GET", e.server.URL+"/api/share/"+link.Token+"/paste-target", nil)
		if uid != "" {
			req.Header.Set("X-Jiange-User-Id", uid)
		}
		r, err := e.guest.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return r.StatusCode, b
	}
	guest := strconv.FormatInt(e.guestUser.ID, 10)
	if code, _ := read(""); code != 400 {
		t.Fatalf("missing account: %d", code)
	}
	if code, _ := read(strconv.FormatInt(e.ownerUser.ID, 10)); code != 401 {
		t.Fatalf("wrong account: %d", code)
	}
	if code, body := read(guest); code != 200 || !bytes.Contains(body, []byte("项目方案")) {
		t.Fatalf("metadata: %d %s", code, body)
	}
	if _, err := e.store.GetDoc(ctx, e.guestUser.ID, e.source.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("metadata joined link: %v", err)
	}
	readPublic := func() int {
		t.Helper()
		req, _ := http.NewRequest("GET", e.server.URL+"/api/share/"+link.Token+"/paste-target?public=1", nil)
		req.Header.Set("X-Jiange-User-Id", guest)
		resp, e := e.guest.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if code := readPublic(); code != 404 {
		t.Fatalf("private link as public: %d", code)
	}
	if _, err := e.store.ChangeLinkRole(ctx, e.source.ID, "anon", "unused"); err != nil {
		t.Fatal(err)
	}
	if code := readPublic(); code != 200 {
		t.Fatalf("public link: %d", code)
	}
	if err := e.store.SetLink(ctx, e.source.ID, store.Link{Role: "none"}); err != nil {
		t.Fatal(err)
	}
	if code, body := read(guest); code != 404 || bytes.Contains(body, []byte("项目方案")) {
		t.Fatalf("closed link: %d %s", code, body)
	}
}
