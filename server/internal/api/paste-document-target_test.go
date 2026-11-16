package api

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"testing"
)

func TestPasteDocumentTargetRequiresMatchingAccountAndAccess(t *testing.T) {
	e := newCopyTestEnv(t)
	request := func(client *http.Client, uid string) (int, []byte) {
		t.Helper()
		req, err := http.NewRequest("GET", e.url()+"/paste-target", nil)
		if err != nil {
			t.Fatal(err)
		}
		if uid != "" {
			req.Header.Set("X-Jiange-User-Id", uid)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		if res.Header.Get("Cache-Control") != "private, no-store" {
			t.Fatal("missing no-store")
		}
		return res.StatusCode, body
	}
	owner := strconv.FormatInt(e.ownerUser.ID, 10)
	guest := strconv.FormatInt(e.guestUser.ID, 10)
	if code, _ := request(e.owner, ""); code != 400 {
		t.Fatalf("missing account: %d", code)
	}
	if code, _ := request(e.owner, guest); code != 401 {
		t.Fatalf("wrong account: %d", code)
	}
	if code, body := request(e.guest, guest); code != 404 || bytes.Contains(body, []byte("项目方案")) {
		t.Fatalf("private: %d %s", code, body)
	}
	e.share(t)
	if code, body := request(e.guest, guest); code != 200 || !bytes.Contains(body, []byte("项目方案")) || bytes.Contains(body, []byte(`"creatorId"`)) {
		t.Fatalf("shared: %d %s", code, body)
	}
	if code, body := request(e.owner, owner); code != 200 || !bytes.Contains(body, []byte("项目方案")) {
		t.Fatalf("owner: %d %s", code, body)
	}
}
