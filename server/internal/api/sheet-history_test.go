package api

import (
	"context"
	"encoding/json"
	"errors"
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

func newSheetHistoryTestMux(srv *Server) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/sheets/{id}/versions", srv.requireUser(http.HandlerFunc(srv.listSheetVersions)))
	mux.Handle("POST /api/sheets/{id}/versions", srv.requireUser(http.HandlerFunc(srv.createSheetVersion)))
	mux.Handle("POST /api/sheets/{id}/versions/{vid}/restore", srv.requireUser(http.HandlerFunc(srv.restoreSheetVersion)))
	mux.Handle("GET /api/sheets/{id}/cell-history", srv.requireUser(http.HandlerFunc(srv.listSheetCellHistory)))
	mux.Handle("/", srv.Handler())
	return mux
}

func TestSheetHistoryAPIAndCellHook(t *testing.T) {
	st := store.NewMemory()
	hub := &sheetsync.Hub{Store: st, PingInterval: 2 * time.Second, SweepInterval: 100 * time.Millisecond}
	srv := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1, SheetHub: hub}
	ts := httptest.NewServer(newSheetHistoryTestMux(srv))
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
		{cOwner, "sh-owner@test.dev", "Owner"},
		{cViewer, "sh-viewer@test.dev", "Viewer"},
		{cOutsider, "sh-outsider@test.dev", "Outsider"},
	} {
		res := post(t, reg.c, ts.URL+"/api/auth/register", map[string]string{"email": reg.email, "name": reg.name, "password": "password123"})
		res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("register %s: %d", reg.email, res.StatusCode)
		}
	}

	ctx := context.Background()
	uOwner, err := st.UserByEmail(ctx, "sh-owner@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	uViewer, err := st.UserByEmail(ctx, "sh-viewer@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	uOutsider, err := st.UserByEmail(ctx, "sh-outsider@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	uidOwner, uidViewer, uidOutsider := strconv64(uOwner.ID), strconv64(uViewer.ID), strconv64(uOutsider.ID)

	res := post(t, cOwner, ts.URL+"/api/drive/nodes", map[string]any{"kind": "sheet", "title": "预算审计", "scope": "personal"})
	var entry store.DriveEntry
	if err := json.NewDecoder(res.Body).Decode(&entry); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if err := st.SetShare(ctx, entry.ID, uViewer.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	idStr := strconv64(entry.ID)

	// Load initial workbook.
	snapRes := sheetReq(t, cOwner, http.MethodGet, ts.URL+"/api/sheets/"+idStr, uidOwner, "1", nil)
	var snap store.SheetSnapshot
	if err := json.NewDecoder(snapRes.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	snapRes.Body.Close()
	ws1 := snap.Sheets[0]

	// 1. Write A1 = "120", replay same batch, then style-only edit, then change A1 to "=120*2".
	v120 := "120"
	batch1 := store.SheetCellBatch{
		MutationID:  "11111111111111111111111111111111",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{
			{RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 0, Raw: &v120},
		},
	}
	r1 := sheetReq(t, cOwner, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/cells", uidOwner, "1", batch1)
	r1.Body.Close()
	if r1.StatusCode != http.StatusOK {
		t.Fatalf("write batch1: %d", r1.StatusCode)
	}
	// Replay same mutationId must NOT duplicate cell history.
	r1Replay := sheetReq(t, cOwner, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/cells", uidOwner, "1", batch1)
	r1Replay.Body.Close()
	if r1Replay.StatusCode != http.StatusOK {
		t.Fatalf("replay batch1: %d", r1Replay.StatusCode)
	}
	// Style-only update must NOT add cell history entry.
	boldStyle := store.SheetCellStyle{Bold: true}
	rStyle := sheetReq(t, cOwner, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/cells", uidOwner, "1", store.SheetCellBatch{
		MutationID:  "22222222222222222222222222222222",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{
			{RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 1, Style: &boldStyle},
		},
	})
	rStyle.Body.Close()
	if rStyle.StatusCode != http.StatusOK {
		t.Fatalf("style-only write: %d", rStyle.StatusCode)
	}
	// Formula edit records prevValue="120", nextFormula="=120*2".
	f240 := "=120*2"
	r2 := sheetReq(t, cOwner, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/cells", uidOwner, "1", store.SheetCellBatch{
		MutationID:  "33333333333333333333333333333333",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{
			{RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 2, Raw: &f240},
		},
	})
	r2.Body.Close()
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("formula write: %d", r2.StatusCode)
	}

	// Verify cell history query & query validation.
	histURL := ts.URL + "/api/sheets/" + idStr + "/cell-history?worksheetId=" + strconv64(ws1.ID) + "&row=0&col=0&limit=10"
	hBad := sheetReq(t, cOwner, http.MethodGet, ts.URL+"/api/sheets/"+idStr+"/cell-history?worksheetId=0&row=0&col=0", uidOwner, "1", nil)
	hBad.Body.Close()
	if hBad.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid worksheetId expected 400, got %d", hBad.StatusCode)
	}
	hOut := sheetReq(t, cOutsider, http.MethodGet, histURL, uidOutsider, "1", nil)
	hOut.Body.Close()
	if hOut.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider cell-history expected 404, got %d", hOut.StatusCode)
	}

	hViewer := sheetReq(t, cViewer, http.MethodGet, histURL, uidViewer, "1", nil)
	var histBody struct {
		Entries []store.SheetCellHistoryEntry `json:"entries"`
	}
	if err := json.NewDecoder(hViewer.Body).Decode(&histBody); err != nil {
		t.Fatal(err)
	}
	hViewer.Body.Close()
	if hViewer.StatusCode != http.StatusOK || len(histBody.Entries) != 2 {
		t.Fatalf("viewer cell-history status=%d entries=%+v", hViewer.StatusCode, histBody.Entries)
	}
	if histBody.Entries[0].PrevValue != "120" || histBody.Entries[0].NextFormula != "=120*2" {
		t.Fatalf("newest cell history unexpected: %+v", histBody.Entries[0])
	}
	if histBody.Entries[1].PrevValue != "" || histBody.Entries[1].NextValue != "120" {
		t.Fatalf("oldest cell history unexpected: %+v", histBody.Entries[1])
	}

	// 2. Create named version, check permissions, edit live sheet, restore + WS notification.
	vViewerFail := sheetReq(t, cViewer, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/versions", uidViewer, "1", map[string]string{"label": "denied"})
	vViewerFail.Body.Close()
	if vViewerFail.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer create version expected 403, got %d", vViewerFail.StatusCode)
	}

	vCreate := sheetReq(t, cOwner, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/versions", uidOwner, "1", map[string]string{"label": "发版基线 v1"})
	var createdBody struct {
		Version store.SheetVersionMeta `json:"version"`
	}
	if err := json.NewDecoder(vCreate.Body).Decode(&createdBody); err != nil {
		t.Fatal(err)
	}
	vCreate.Body.Close()
	if vCreate.StatusCode != http.StatusCreated || createdBody.Version.Label != "发版基线 v1" || createdBody.Version.CellCount != 1 {
		t.Fatalf("create version status=%d body=%+v", vCreate.StatusCode, createdBody)
	}

	// Overwrite A1 before restoring.
	v999 := "999"
	rOver := sheetReq(t, cOwner, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/cells", uidOwner, "1", store.SheetCellBatch{
		MutationID:  "44444444444444444444444444444444",
		WorksheetID: ws1.ID,
		Cells: []store.SheetCellWrite{
			{RowID: ws1.Rows[0].ID, ColumnID: ws1.Columns[0].ID, ExpectedRevision: 3, Raw: &v999},
		},
	})
	rOver.Body.Close()
	if rOver.StatusCode != http.StatusOK {
		t.Fatalf("overwrite write: %d", rOver.StatusCode)
	}

	// Connect viewer WebSocket to verify restore triggers SheetHub broadcast.
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

	// Viewer cannot restore.
	vRestURL := ts.URL + "/api/sheets/" + idStr + "/versions/" + strconv64(createdBody.Version.ID) + "/restore"
	vRestDeny := sheetReq(t, cViewer, http.MethodPost, vRestURL, uidViewer, "1", nil)
	vRestDeny.Body.Close()
	if vRestDeny.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer restore expected 403, got %d", vRestDeny.StatusCode)
	}

	// Owner restores v1 -> returns restored snapshot and notifies SheetHub.
	vRest := sheetReq(t, cOwner, http.MethodPost, vRestURL, uidOwner, "1", nil)
	var restoredSnap store.SheetSnapshot
	if err := json.NewDecoder(vRest.Body).Decode(&restoredSnap); err != nil {
		t.Fatal(err)
	}
	vRest.Body.Close()
	if vRest.StatusCode != http.StatusOK || len(restoredSnap.Sheets) != 1 || len(restoredSnap.Sheets[0].Cells) != 1 || restoredSnap.Sheets[0].Cells[0].Raw != "=120*2" {
		t.Fatalf("restore snapshot unexpected: status=%d snap=%+v", vRest.StatusCode, restoredSnap)
	}

	wsCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	gotRev := false
	for !gotRev {
		_, data, err := wsConn.Read(wsCtx)
		if err != nil {
			t.Fatalf("ws read after restore: %v", err)
		}
		var frame struct {
			Type             string `json:"type"`
			WorkbookRevision int64  `json:"workbookRevision"`
		}
		if json.Unmarshal(data, &frame) == nil && frame.Type == "revision" && frame.WorkbookRevision == restoredSnap.WorkbookRevision {
			gotRev = true
		}
	}

	// List versions now shows pre-restore backup + manual v1.
	vListRes := sheetReq(t, cViewer, http.MethodGet, ts.URL+"/api/sheets/"+idStr+"/versions", uidViewer, "1", nil)
	var listBody struct {
		Versions []store.SheetVersionMeta `json:"versions"`
	}
	if err := json.NewDecoder(vListRes.Body).Decode(&listBody); err != nil {
		t.Fatal(err)
	}
	vListRes.Body.Close()
	if vListRes.StatusCode != http.StatusOK || len(listBody.Versions) != 2 || !listBody.Versions[0].AutoSaved || listBody.Versions[0].Label != "恢复前自动备份" {
		t.Fatalf("list versions after restore unexpected: status=%d versions=%+v", vListRes.StatusCode, listBody.Versions)
	}
}

type failingCellHistoryStore struct {
	*store.Memory
}

func (f *failingCellHistoryStore) RecordSheetCellHistory(context.Context, []store.SheetCellHistoryEntry) error {
	return errors.New("simulated history write failure")
}

func TestSheetCellWriteSucceedsWhenHistoryRecordFails(t *testing.T) {
	st := &failingCellHistoryStore{Memory: store.NewMemory()}
	srv := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1}
	ts := httptest.NewServer(newSheetHistoryTestMux(srv))
	defer ts.Close()

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	res := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "failhist@test.dev", "name": "Owner", "password": "password123"})
	res.Body.Close()
	u, _ := st.UserByEmail(context.Background(), "failhist@test.dev")
	uid := strconv64(u.ID)

	res = post(t, client, ts.URL+"/api/drive/nodes", map[string]any{"kind": "sheet", "title": "容错测试", "scope": "personal"})
	var entry store.DriveEntry
	_ = json.NewDecoder(res.Body).Decode(&entry)
	res.Body.Close()
	idStr := strconv64(entry.ID)

	snapRes := sheetReq(t, client, http.MethodGet, ts.URL+"/api/sheets/"+idStr, uid, "1", nil)
	var snap store.SheetSnapshot
	_ = json.NewDecoder(snapRes.Body).Decode(&snap)
	snapRes.Body.Close()

	raw := "ok"
	writeRes := sheetReq(t, client, http.MethodPost, ts.URL+"/api/sheets/"+idStr+"/cells", uid, "1", store.SheetCellBatch{
		MutationID:  "55555555555555555555555555555555",
		WorksheetID: snap.Sheets[0].ID,
		Cells: []store.SheetCellWrite{
			{RowID: snap.Sheets[0].Rows[0].ID, ColumnID: snap.Sheets[0].Columns[0].ID, ExpectedRevision: 0, Raw: &raw},
		},
	})
	writeRes.Body.Close()
	if writeRes.StatusCode != http.StatusOK {
		t.Fatalf("cell write should still succeed when history fails, got %d", writeRes.StatusCode)
	}
}
