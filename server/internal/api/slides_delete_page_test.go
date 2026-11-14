package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestDeleteSlidePageAccountAndRevision(t *testing.T) {
	ts, client := newTestServer(t, store.NewMemory(), nil)
	post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "slide-delete-api@example.test", "name": "Owner", "password": "password123"}).Body.Close()
	var deck store.DriveEntry
	res := post(t, client, ts.URL+"/api/drive/nodes", map[string]any{"kind": "slides", "title": "Deck", "scope": "personal"})
	if res.StatusCode != 201 {
		t.Fatalf("deck: %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&deck); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res, err := client.Get(fmt.Sprintf("%s/api/slides/%d/pages", ts.URL, deck.ID))
	if err != nil {
		t.Fatal(err)
	}
	var initial struct {
		Pages []store.SlidesPage `json:"pages"`
	}
	if err = json.NewDecoder(res.Body).Decode(&initial); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if len(initial.Pages) != 1 {
		t.Fatalf("initial: %+v", initial.Pages)
	}
	page := initial.Pages[0]
	url := fmt.Sprintf("%s/api/slides/%d/pages/%d/delete", ts.URL, deck.ID, page.ID)
	call := func(account, body string) (int, map[string]int64) {
		req, e := http.NewRequest("POST", url, bytes.NewBufferString(body))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Content-Type", "application/json")
		if account != "" {
			req.Header.Set("X-Jiange-User-Id", account)
		}
		response, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		var receipt map[string]int64
		if response.StatusCode == 200 {
			if e = json.NewDecoder(response.Body).Decode(&receipt); e != nil {
				t.Fatal(e)
			}
		}
		return response.StatusCode, receipt
	}
	account := fmt.Sprint(deck.CreatorID)
	for _, tc := range []struct {
		account, body string
		want          int
	}{{"", `{"expectedRevision":1}`, 400}, {"999999", `{"expectedRevision":1}`, 401}, {account, `{}`, 400}, {account, `{"expectedRevision":99}`, 409}} {
		if status, _ := call(tc.account, tc.body); status != tc.want {
			t.Fatalf("%+v: %d", tc, status)
		}
	}
	status, receipt := call(account, `{"expectedRevision":1}`)
	if status != 200 || receipt["deletedId"] != page.ID || receipt["slidesId"] != deck.ID || receipt["revision"] != page.Revision {
		t.Fatalf("receipt: %d %+v", status, receipt)
	}
	if status, _ = call(account, `{"expectedRevision":1}`); status != 404 {
		t.Fatalf("repeat: %d", status)
	}
}
