package sheetsync_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/sheetsync"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/coder/websocket"
)

func TestSheetSyncPresenceAndRevision(t *testing.T) {
	mem := store.NewMemory()
	ctx := context.Background()
	u1, ws1, err := mem.CreateUser(ctx, "a@example.test", "Alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	u2, _, err := mem.CreateUser(ctx, "b@example.test", "Bob", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: u1.ID, SessionHash: []byte("sess1")}
	if err = mem.CreateSession(ctx, guard.SessionHash, u1.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	entry, err := mem.CreateDriveNodeWithType(ctx, guard, ws1.ID, nil, "sheet", "", "协作表格", false)
	if err != nil {
		t.Fatal(err)
	}

	hub := &sheetsync.Hub{Store: mem, PingInterval: 2 * time.Second, SweepInterval: 100 * time.Millisecond}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := u1
		if r.URL.Query().Get("u") == "2" {
			user = u2
		}
		hub.Serve(w, r, entry.ID, user, func(context.Context) error { return nil })
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	c1, _, err := websocket.Dial(ctx, wsURL+"?u=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.CloseNow()
	c2, _, err := websocket.Dial(ctx, wsURL+"?u=2", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.CloseNow()

	cursorPayload, _ := json.Marshal(map[string]any{"type": "cursor", "worksheetId": 1, "row": 4, "col": 5, "anchorRow": 2, "anchorCol": 3, "editing": true})
	if err = c2.Write(ctx, websocket.MessageText, cursorPayload); err != nil {
		t.Fatal(err)
	}

	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	sawBobCursor := false
	for !sawBobCursor {
		_, raw, err := c1.Read(readCtx)
		if err != nil {
			t.Fatalf("read presence on c1: %v", err)
		}
		var frame struct {
			Type          string                   `json:"type"`
			Collaborators []sheetsync.Collaborator `json:"collaborators"`
		}
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "presence" {
			for _, col := range frame.Collaborators {
				if col.UserID == u2.ID && col.WorksheetID == 1 && col.Row == 4 && col.Col == 5 && col.AnchorRow == 2 && col.AnchorCol == 3 && col.Editing {
					sawBobCursor = true
				}
			}
		}
	}

	hub.NotifyCells(entry.ID, 5, u2.ID, 1, []store.SheetCellRevision{
		{RowID: 10, ColumnID: 20, Revision: 2, Raw: "SyncedDelta", Merged: true},
	})
	sawRevision := false
	for !sawRevision {
		_, raw, err := c1.Read(readCtx)
		if err != nil {
			t.Fatalf("read revision on c1: %v", err)
		}
		var frame struct {
			Type             string                    `json:"type"`
			WorkbookRevision int64                     `json:"workbookRevision"`
			ActorID          int64                     `json:"actorId"`
			WorksheetID      int64                     `json:"worksheetId"`
			CellDelta        []store.SheetCellRevision `json:"cellDelta"`
		}
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "revision" && frame.WorkbookRevision == 5 && frame.ActorID == u2.ID && frame.WorksheetID == 1 && len(frame.CellDelta) == 1 && frame.CellDelta[0].Raw == "SyncedDelta" && frame.CellDelta[0].Merged {
			sawRevision = true
		}
	}
}
