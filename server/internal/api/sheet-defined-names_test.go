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
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/sheetsync"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/coder/websocket"
)

func newSheetDefinedNamesTestMux(srv *Server) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/sheets/{id}/defined-names", srv.requireUser(http.HandlerFunc(srv.getSheetDefinedNames)))
	mux.Handle("PUT /api/sheets/{id}/defined-names", srv.requireUser(http.HandlerFunc(srv.putSheetDefinedNames)))
	mux.Handle("/", srv.Handler())
	return mux
}

func TestSheetDefinedNamesAPIAndBroadcast(t *testing.T) {
	st := store.NewMemory()
	hub := &sheetsync.Hub{Store: st, PingInterval: 2 * time.Second, SweepInterval: 100 * time.Millisecond}
	srv := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1, SheetHub: hub}
	ts := httptest.NewServer(newSheetDefinedNamesTestMux(srv))
	defer ts.Close()

	jarOwner, _ := cookiejar.New(nil)
	jarViewer, _ := cookiejar.New(nil)
	jarOutsider, _ := cookiejar.New(nil)
	cOwner := &http.Client{Jar: jarOwner}
	cViewer := &http.Client{Jar: jarViewer}
	cOutsider := &http.Client{Jar: jarOutsider}

	for _, reg := range []struct {
		c     *http.Client
		email string
		name  string
	}{
		{cOwner, "dn-api-owner@test.dev", "Owner"},
		{cViewer, "dn-api-viewer@test.dev", "Viewer"},
		{cOutsider, "dn-api-outsider@test.dev", "Outsider"},
	} {
		res := post(t, reg.c, ts.URL+"/api/auth/register", map[string]string{"email": reg.email, "name": reg.name, "password": "password123"})
		res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("register %s: %d", reg.email, res.StatusCode)
		}
	}

	ctx := context.Background()
	uOwner, err := st.UserByEmail(ctx, "dn-api-owner@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	uViewer, err := st.UserByEmail(ctx, "dn-api-viewer@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	uOutsider, err := st.UserByEmail(ctx, "dn-api-outsider@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	uidOwner, uidViewer, uidOutsider := strconv64(uOwner.ID), strconv64(uViewer.ID), strconv64(uOutsider.ID)

	res := post(t, cOwner, ts.URL+"/api/drive/nodes", map[string]any{"kind": "sheet", "title": "名称管理器表", "scope": "personal"})
	var entry store.DriveEntry
	if err := json.NewDecoder(res.Body).Decode(&entry); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if err := st.SetShare(ctx, entry.ID, uViewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	idStr := strconv64(entry.ID)
	dnURL := ts.URL + "/api/sheets/" + idStr + "/defined-names"

	// Fetch workbook to obtain worksheet ID.
	snapRes := sheetReq(t, cOwner, http.MethodGet, ts.URL+"/api/sheets/"+idStr, uidOwner, "1", nil)
	var snap store.SheetSnapshot
	if err := json.NewDecoder(snapRes.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	snapRes.Body.Close()
	ws1ID := snap.Sheets[0].ID

	// 1. Guard header enforcement.
	badVer := sheetReq(t, cOwner, http.MethodGet, dnURL, uidOwner, "99", nil)
	badVer.Body.Close()
	if badVer.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("outdated protocol version expected 426, got %d", badVer.StatusCode)
	}
	noAcct := sheetReq(t, cOwner, http.MethodGet, dnURL, "", "1", nil)
	noAcct.Body.Close()
	if noAcct.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing account header expected 400, got %d", noAcct.StatusCode)
	}

	// 2. Initial GET returns empty JSON array; outsider gets 404.
	outGet := sheetReq(t, cOutsider, http.MethodGet, dnURL, uidOutsider, "1", nil)
	outGet.Body.Close()
	if outGet.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider GET expected 404, got %d", outGet.StatusCode)
	}

	initRes := sheetReq(t, cViewer, http.MethodGet, dnURL, uidViewer, "1", nil)
	initRaw, err := io.ReadAll(initRes.Body)
	initRes.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if initRes.StatusCode != http.StatusOK || !strings.Contains(string(initRaw), `"definedNames":[]`) {
		t.Fatalf("initial GET status=%d body=%s", initRes.StatusCode, string(initRaw))
	}

	// 3. Viewer PUT is forbidden; outsider PUT is 404.
	viewerPut := sheetReq(t, cViewer, http.MethodPut, dnURL, uidViewer, "1", map[string]any{
		"definedNames": []store.SheetDefinedName{{Name: "TaxRate", Ref: "Sheet1!A1"}},
	})
	viewerPut.Body.Close()
	if viewerPut.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer PUT expected 403, got %d", viewerPut.StatusCode)
	}
	outsiderPut := sheetReq(t, cOutsider, http.MethodPut, dnURL, uidOutsider, "1", map[string]any{
		"definedNames": []store.SheetDefinedName{{Name: "TaxRate", Ref: "Sheet1!A1"}},
	})
	outsiderPut.Body.Close()
	if outsiderPut.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider PUT expected 404, got %d", outsiderPut.StatusCode)
	}

	// 4. Connect viewer WS to verify PUT broadcasts SheetHub reload event.
	wsURL := strings.Replace(ts.URL, "http://", "ws://", 1) + "/api/sheets/" + idStr + "/ws"
	parsedTS, _ := url.Parse(ts.URL)
	wsHdr := http.Header{}
	for _, ck := range cViewer.Jar.Cookies(parsedTS) {
		wsHdr.Add("Cookie", ck.Name+"="+ck.Value)
	}
	wsConn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: wsHdr})
	if err != nil {
		t.Fatal(err)
	}
	defer wsConn.CloseNow()

	// 5. Owner PUT saves workbook-global + worksheet-scoped names.
	putRes := sheetReq(t, cOwner, http.MethodPut, dnURL, uidOwner, "1", map[string]any{
		"definedNames": []store.SheetDefinedName{
			{Name: "TaxRate", Ref: "Sheet1!$A$1", Comment: "默认税率"},
			{Name: "TaxRate", Ref: "Sheet1!B1:B5", SheetID: &ws1ID, Comment: "局部税率"},
		},
	})
	var putBody struct {
		DefinedNames []store.SheetDefinedName `json:"definedNames"`
	}
	if err := json.NewDecoder(putRes.Body).Decode(&putBody); err != nil {
		t.Fatal(err)
	}
	putRes.Body.Close()
	if putRes.StatusCode != http.StatusOK || len(putBody.DefinedNames) != 2 {
		t.Fatalf("owner PUT status=%d body=%+v", putRes.StatusCode, putBody)
	}
	if putBody.DefinedNames[0].Name != "TaxRate" || putBody.DefinedNames[0].SheetID != nil || putBody.DefinedNames[0].Comment != "默认税率" {
		t.Fatalf("unexpected global defined name: %+v", putBody.DefinedNames[0])
	}
	if putBody.DefinedNames[1].SheetID == nil || *putBody.DefinedNames[1].SheetID != ws1ID {
		t.Fatalf("unexpected scoped defined name: %+v", putBody.DefinedNames[1])
	}

	// Confirm SheetHub revision broadcast arrives on viewer WS.
	wsCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	gotRev := false
	for !gotRev {
		_, data, err := wsConn.Read(wsCtx)
		if err != nil {
			t.Fatalf("ws read after PUT defined-names: %v", err)
		}
		var frame struct {
			Type             string `json:"type"`
			WorkbookRevision int64  `json:"workbookRevision"`
			ActorID          int64  `json:"actorId"`
		}
		if json.Unmarshal(data, &frame) == nil && frame.Type == "revision" && frame.ActorID == uOwner.ID {
			gotRev = true
		}
	}

	// Viewer GET sees persisted names.
	vGet := sheetReq(t, cViewer, http.MethodGet, dnURL, uidViewer, "1", nil)
	var vBody struct {
		DefinedNames []store.SheetDefinedName `json:"definedNames"`
	}
	if err := json.NewDecoder(vGet.Body).Decode(&vBody); err != nil {
		t.Fatal(err)
	}
	vGet.Body.Close()
	if vGet.StatusCode != http.StatusOK || len(vBody.DefinedNames) != 2 {
		t.Fatalf("viewer GET after save status=%d body=%+v", vGet.StatusCode, vBody)
	}

	// 6. Validation errors return 400.
	badPayloads := []map[string]any{
		{},
		{"definedNames": []store.SheetDefinedName{{Name: "1Bad", Ref: "A1"}}},
		{"definedNames": []store.SheetDefinedName{{Name: "GoodName", Ref: ""}}},
		{"definedNames": []store.SheetDefinedName{{Name: "Dup", Ref: "A1"}, {Name: "dup", Ref: "A2"}}},
	}
	for i, payload := range badPayloads {
		badRes := sheetReq(t, cOwner, http.MethodPut, dnURL, uidOwner, "1", payload)
		badRes.Body.Close()
		if badRes.StatusCode != http.StatusBadRequest {
			t.Fatalf("bad payload #%d expected 400, got %d", i, badRes.StatusCode)
		}
	}

	// 7. Empty array clears defined names cleanly.
	clearRes := sheetReq(t, cOwner, http.MethodPut, dnURL, uidOwner, "1", map[string]any{
		"definedNames": []store.SheetDefinedName{},
	})
	clearRaw, err := io.ReadAll(clearRes.Body)
	clearRes.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if clearRes.StatusCode != http.StatusOK || !strings.Contains(string(clearRaw), `"definedNames":[]`) {
		t.Fatalf("clear PUT status=%d body=%s", clearRes.StatusCode, string(clearRaw))
	}
}
