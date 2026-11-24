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

func TestSheetSyncMultiReplicaFanout(t *testing.T) {
	mem := store.NewMemory()
	ctx := context.Background()
	u1, ws1, err := mem.CreateUser(ctx, "sheet-m1@example.test", "Alice", "hash")
	if err != nil {
		t.Fatal(err)
	}
	u2, _, err := mem.CreateUser(ctx, "sheet-m2@example.test", "Bob", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: u1.ID, SessionHash: []byte("sheet-multi-sess")}
	if err = mem.CreateSession(ctx, guard.SessionHash, u1.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	entry, err := mem.CreateDriveNodeWithType(ctx, guard, ws1.ID, nil, "sheet", "", "多副本协作表格", false)
	if err != nil {
		t.Fatal(err)
	}

	// Huge SweepInterval proves delivery comes exclusively from RealtimeBus.
	hubA := &sheetsync.Hub{Store: mem, PingInterval: time.Hour, SweepInterval: time.Hour}
	hubB := &sheetsync.Hub{Store: mem, PingInterval: time.Hour, SweepInterval: time.Hour}

	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	go func() { _ = hubA.Run(runCtx) }()
	go func() { _ = hubB.Run(runCtx) }()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && mem.RealtimeSubscriberCount(sheetsync.RealtimeChannel) < 2 {
		time.Sleep(5 * time.Millisecond)
	}
	if got := mem.RealtimeSubscriberCount(sheetsync.RealtimeChannel); got != 2 {
		t.Fatalf("expected 2 sheet realtime subscribers, got %d", got)
	}

	srvA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hubA.Serve(w, r, entry.ID, u1, func(context.Context) error { return nil })
	}))
	defer srvA.Close()
	srvB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hubB.Serve(w, r, entry.ID, u2, func(context.Context) error { return nil })
	}))
	defer srvB.Close()

	c1, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srvA.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.CloseNow()
	c2, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srvB.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.CloseNow()

	// 1. Cross-replica cursor presence: Bob on hubB -> Alice on hubA.
	cursorPayload, _ := json.Marshal(map[string]any{
		"type": "cursor", "worksheetId": 1, "row": 7, "col": 3, "anchorRow": 7, "anchorCol": 2, "editing": true,
	})
	if err = c2.Write(ctx, websocket.MessageText, cursorPayload); err != nil {
		t.Fatal(err)
	}
	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	for {
		_, raw, err := c1.Read(readCtx)
		if err != nil {
			t.Fatalf("read remote cursor presence on c1: %v", err)
		}
		var frame struct {
			Type          string                   `json:"type"`
			Collaborators []sheetsync.Collaborator `json:"collaborators"`
		}
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "presence" {
			found := false
			for _, col := range frame.Collaborators {
				if col.UserID == u2.ID && col.WorksheetID == 1 && col.Row == 7 && col.Col == 3 && col.Editing {
					found = true
				}
			}
			if found {
				break
			}
		}
	}

	// 2. Cross-replica compact cell delta: hubA.NotifyCells -> c2 on hubB receives cellDelta.
	hubA.NotifyCells(entry.ID, 12, u1.ID, 1, []store.SheetCellRevision{
		{RowID: 1, ColumnID: 2, Revision: 3, Raw: "CrossReplicaCell"},
	})
	for {
		_, raw, err := c2.Read(readCtx)
		if err != nil {
			t.Fatalf("read remote cell delta on c2: %v", err)
		}
		var frame struct {
			Type             string                    `json:"type"`
			WorkbookRevision int64                     `json:"workbookRevision"`
			ActorID          int64                     `json:"actorId"`
			WorksheetID      int64                     `json:"worksheetId"`
			CellDelta        []store.SheetCellRevision `json:"cellDelta"`
		}
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "revision" && frame.WorkbookRevision == 12 {
			if frame.ActorID != u1.ID || frame.WorksheetID != 1 || len(frame.CellDelta) != 1 || frame.CellDelta[0].Raw != "CrossReplicaCell" {
				t.Fatalf("unexpected remote cell delta frame: %+v", frame)
			}
			break
		}
	}

	// 3. Oversized cell delta (>8000 bytes) gracefully falls back to compact revision invalidation across bus.
	hugeRaw := strings.Repeat("Z", 9000)
	hubA.NotifyCells(entry.ID, 13, u1.ID, 1, []store.SheetCellRevision{
		{RowID: 2, ColumnID: 3, Revision: 4, Raw: hugeRaw},
	})
	for {
		_, raw, err := c2.Read(readCtx)
		if err != nil {
			t.Fatalf("read remote fallback revision on c2: %v", err)
		}
		var frame struct {
			Type             string                    `json:"type"`
			WorkbookRevision int64                     `json:"workbookRevision"`
			ActorID          int64                     `json:"actorId"`
			CellDelta        []store.SheetCellRevision `json:"cellDelta"`
		}
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "revision" && frame.WorkbookRevision == 13 {
			if frame.ActorID != u1.ID || len(frame.CellDelta) != 0 {
				t.Fatalf("expected compact fallback revision without oversized cellDelta, got %+v", frame)
			}
			break
		}
	}

	// 4. Bob disconnects from hubB -> Alice on hubA sees Bob removed from presence.
	_ = c2.Close(websocket.StatusNormalClosure, "bye")
	for {
		_, raw, err := c1.Read(readCtx)
		if err != nil {
			t.Fatalf("read remote leave presence on c1: %v", err)
		}
		var frame struct {
			Type          string                   `json:"type"`
			Collaborators []sheetsync.Collaborator `json:"collaborators"`
		}
		if json.Unmarshal(raw, &frame) == nil && frame.Type == "presence" {
			hasBob := false
			for _, col := range frame.Collaborators {
				if col.UserID == u2.ID {
					hasBob = true
				}
			}
			if !hasBob {
				break
			}
		}
	}
}
