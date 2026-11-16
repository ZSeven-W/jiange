package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

func TestReferenceVisibilityAccountPermissionsAndConflict(t *testing.T) {
	e := newCopyTestEnv(t)
	e.share(t)
	req := func(client *http.Client, method, uid, body string) (int, []byte) {
		t.Helper()
		r, _ := http.NewRequest(method, e.url()+"/reference-visibility", strings.NewReader(body))
		if uid != "" {
			r.Header.Set("X-Jiange-User-Id", uid)
		}
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}
	owner := strconv.FormatInt(e.ownerUser.ID, 10)
	guest := strconv.FormatInt(e.guestUser.ID, 10)
	if status, _ := req(e.owner, "GET", "", ""); status != 400 {
		t.Fatalf("missing: %d", status)
	}
	if status, _ := req(e.owner, "GET", guest, ""); status != 401 {
		t.Fatalf("wrong: %d", status)
	}
	if status, _ := req(e.guest, "PUT", guest, `{"visible":false,"expectedRevision":0}`); status != 403 {
		t.Fatalf("viewer: %d", status)
	}
	status, body := req(e.owner, "PUT", owner, `{"visible":false,"expectedRevision":0}`)
	if status != 200 || !bytes.Contains(body, []byte(`"visible":false`)) {
		t.Fatalf("hide: %d %s", status, body)
	}
	status, body = req(e.guest, "GET", guest, "")
	var got struct {
		Visible  bool  `json:"visible"`
		Revision int64 `json:"revision"`
	}
	if json.Unmarshal(body, &got) != nil || status != 200 || got.Visible || got.Revision != 1 {
		t.Fatalf("viewer: %d %s", status, body)
	}
	// Hiding is presentation, not an authorization change.
	query, _ := http.NewRequest("GET", e.url()+"/references", nil)
	query.Header.Set("X-Jiange-User-Id", guest)
	queryResponse, err := e.guest.Do(query)
	if err != nil {
		t.Fatal(err)
	}
	queryResponse.Body.Close()
	if queryResponse.StatusCode != http.StatusOK {
		t.Fatalf("hidden references access: %d", queryResponse.StatusCode)
	}
	if status, _ = req(e.owner, "PUT", owner, `{"visible":true,"expectedRevision":0}`); status != 409 {
		t.Fatalf("conflict: %d", status)
	}
	if status, _ = req(e.owner, "PUT", owner, `{"visible":true}`); status != 400 {
		t.Fatalf("invalid: %d", status)
	}
}
