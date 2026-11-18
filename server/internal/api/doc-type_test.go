package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

func TestDocTypeBoardLifecycle(t *testing.T) {
	st := store.NewMemory()
	ts, c := newTestServer(t, st, nil)
	reg := post(t, c, ts.URL+"/api/auth/register", map[string]string{"email": "board@test.dev", "name": "Boarder", "password": "password123"})
	reg.Body.Close()
	u, err := st.UserByEmail(context.Background(), "board@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	uid := strconv64(u.ID)

	// Invalid docType is rejected.
	if res := post(t, c, ts.URL+"/api/docs", map[string]string{"title": "Bad", "docType": "sheet"}); res.StatusCode != http.StatusBadRequest {
		res.Body.Close()
		t.Fatalf("POST /api/docs invalid docType: got %d", res.StatusCode)
	} else {
		res.Body.Close()
	}
	if res := post(t, c, ts.URL+"/api/drive/nodes", map[string]string{"kind": "base", "title": "Bad", "docType": "board"}); res.StatusCode != http.StatusBadRequest {
		res.Body.Close()
		t.Fatalf("POST /api/drive/nodes board on base: got %d", res.StatusCode)
	} else {
		res.Body.Close()
	}

	// Account-bound creation via word-import-nodes sets docType atomically.
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/drive/word-import-nodes", bytes.NewBufferString(`{"kind":"doc","docType":"board","title":"未命名画板","scope":"personal"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", uid)
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var driveBoard store.DriveEntry
	if err = json.NewDecoder(res.Body).Decode(&driveBoard); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusCreated || driveBoard.DocType != store.DocTypeBoard || driveBoard.Kind != "doc" {
		t.Fatalf("created drive board: status=%d entry=%+v", res.StatusCode, driveBoard)
	}

	// Untitled board via POST /api/docs preserves board subtype and defaults duplicate title to 未命名画板 副本.
	res = post(t, c, ts.URL+"/api/docs", map[string]string{"title": "", "docType": "board"})
	var untitled store.DocMeta
	if err = json.NewDecoder(res.Body).Decode(&untitled); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusCreated || untitled.DocType != store.DocTypeBoard {
		t.Fatalf("created untitled board: status=%d doc=%+v", res.StatusCode, untitled)
	}

	dupReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/docs/"+strconv64(untitled.ID)+"/account-duplicate", nil)
	dupReq.Header.Set("X-Jiange-User-Id", uid)
	dupRes, err := c.Do(dupReq)
	if err != nil {
		t.Fatal(err)
	}
	var copied store.DocMeta
	if err = json.NewDecoder(dupRes.Body).Decode(&copied); err != nil {
		t.Fatal(err)
	}
	dupRes.Body.Close()
	if dupRes.StatusCode != http.StatusCreated || copied.DocType != store.DocTypeBoard || copied.Title != "未命名画板 副本" {
		t.Fatalf("duplicated untitled board: status=%d doc=%+v", dupRes.StatusCode, copied)
	}

	// Drive rename preserves board docType.
	res = post(t, c, ts.URL+"/api/drive/rename/"+strconv64(driveBoard.ID), map[string]any{"title": "团队白板", "expected": driveBoard.Revision})
	var renamed store.DriveEntry
	if err = json.NewDecoder(res.Body).Decode(&renamed); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK || renamed.DocType != store.DocTypeBoard || renamed.Title != "团队白板" {
		t.Fatalf("renamed drive board: status=%d entry=%+v", res.StatusCode, renamed)
	}

	// Search, recent visit, trash, and restore all preserve docType="board".
	res = post(t, c, ts.URL+"/api/docs/"+strconv64(driveBoard.ID)+"/visit", map[string]any{})
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("record visit: %d", res.StatusCode)
	}
	recentRes, err := c.Get(ts.URL + "/api/recent")
	if err != nil {
		t.Fatal(err)
	}
	var recentBody struct{ Docs []store.RecentDoc }
	if err = json.NewDecoder(recentRes.Body).Decode(&recentBody); err != nil {
		t.Fatal(err)
	}
	recentRes.Body.Close()
	if len(recentBody.Docs) == 0 || recentBody.Docs[0].ID != driveBoard.ID || recentBody.Docs[0].DocType != store.DocTypeBoard {
		t.Fatalf("recent docs missing board DocType: %+v", recentBody.Docs)
	}

	searchRes, err := c.Get(ts.URL + "/api/search?q=团队白板")
	if err != nil {
		t.Fatal(err)
	}
	var searchBody struct{ Docs []store.DocMeta }
	if err = json.NewDecoder(searchRes.Body).Decode(&searchBody); err != nil {
		t.Fatal(err)
	}
	searchRes.Body.Close()
	if len(searchBody.Docs) != 1 || searchBody.Docs[0].ID != driveBoard.ID || searchBody.Docs[0].DocType != store.DocTypeBoard {
		t.Fatalf("search missing board DocType: %+v", searchBody.Docs)
	}

	res = post(t, c, ts.URL+"/api/drive/trash/"+strconv64(driveBoard.ID), map[string]any{"expected": renamed.Revision})
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("trash board: %d", res.StatusCode)
	}
	trashRes, err := c.Get(ts.URL + "/api/trash")
	if err != nil {
		t.Fatal(err)
	}
	var trashBody struct{ Docs []store.DocMeta }
	if err = json.NewDecoder(trashRes.Body).Decode(&trashBody); err != nil {
		t.Fatal(err)
	}
	trashRes.Body.Close()
	if len(trashBody.Docs) != 1 || trashBody.Docs[0].ID != driveBoard.ID || trashBody.Docs[0].DocType != store.DocTypeBoard {
		t.Fatalf("trash missing board DocType: %+v", trashBody.Docs)
	}

	res = post(t, c, ts.URL+"/api/drive/restore/"+strconv64(driveBoard.ID), map[string]any{"expected": trashBody.Docs[0].DriveRevision})
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("restore board: %d", res.StatusCode)
	}
	getRes, err := c.Get(ts.URL + "/api/docs/" + strconv64(driveBoard.ID))
	if err != nil {
		t.Fatal(err)
	}
	var restored store.DocMeta
	if err = json.NewDecoder(getRes.Body).Decode(&restored); err != nil {
		t.Fatal(err)
	}
	getRes.Body.Close()
	if getRes.StatusCode != http.StatusOK || restored.DocType != store.DocTypeBoard {
		t.Fatalf("restored board meta: status=%d doc=%+v", getRes.StatusCode, restored)
	}
}
