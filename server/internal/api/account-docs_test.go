package api

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"testing"
)

func TestAccountDocumentListRequiresMatchingSession(t *testing.T) {
	e := newCopyTestEnv(t)
	request := func(client *http.Client, id string) (int, []byte) {
		t.Helper()
		req, err := http.NewRequest("GET", e.server.URL+"/api/account-docs", nil)
		if err != nil {
			t.Fatal(err)
		}
		if id != "" {
			req.Header.Set("X-Jiange-User-Id", id)
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
	if code, _ := request(e.owner, ""); code != http.StatusBadRequest {
		t.Fatalf("missing account: %d", code)
	}
	if code, _ := request(e.owner, strconv.FormatInt(e.guestUser.ID, 10)); code != http.StatusUnauthorized {
		t.Fatalf("wrong account: %d", code)
	}
	if code, body := request(e.owner, strconv.FormatInt(e.ownerUser.ID, 10)); code != http.StatusOK || !bytes.Contains(body, []byte("项目方案")) || bytes.Contains(body, []byte(`"creatorId"`)) {
		t.Fatalf("owner: %d %s", code, body)
	}
	if code, body := request(e.guest, strconv.FormatInt(e.guestUser.ID, 10)); code != http.StatusOK || bytes.Contains(body, []byte("项目方案")) {
		t.Fatalf("private document leaked: %d %s", code, body)
	}
}
