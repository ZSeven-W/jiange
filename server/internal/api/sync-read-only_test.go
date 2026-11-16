package api

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
	"github.com/coder/websocket"
)

func TestReadOnlySyncProjectsAndUpdates(t *testing.T) {
	ctx := context.Background()
	e := newCopyTestEnv(t)
	e.share(t)
	s := &Server{Store: e.store, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100, Hub: &syncsrv.Hub{Store: e.store, PingInterval: time.Hour}}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	seed := &Server{Store: e.store}
	seedDoc(t, seed, e.source.ID, "🦄")
	seedDoc(t, seed, e.source.ID, "当前内容")
	doc, _, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	hidden := doc.CreateBlock(21, collab.Root, "Z", "paragraph")
	secret := "HIDDEN-OLD-PROPERTY"
	setHidden := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 21, Clock: doc.Clock() + 1}, Block: hidden.ID, Key: "name", Value: &secret}
	doc.Apply(setHidden)
	deleted := collab.Op{T: collab.TBlockDelete, ID: collab.OpID{Client: 21, Clock: doc.Clock() + 1}, Block: hidden.ID}
	doc.Apply(deleted)
	stale := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 21, Clock: doc.Clock() + 1}, Block: collab.OpID{Client: 0, Clock: 2}, Key: "caption", Value: &secret}
	doc.Apply(stale)
	for _, op := range []collab.Op{hidden, setHidden, deleted, stale} {
		b, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = e.store.AppendOps(ctx, e.source.ID, []store.RawOp{{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: b}}); err != nil {
			t.Fatal(err)
		}
	}
	connect := func(client *http.Client, protocol string, advertised ...uint64) (*websocket.Conn, collab.ServerMsg) {
		t.Helper()
		target := strings.Replace(ts.URL, "http", "ws", 1) + "/api/sync" + protocol
		ws, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPClient: client})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ws.CloseNow() })
		var clientID, lastSeq uint64
		if len(advertised) > 0 {
			clientID = advertised[0]
		}
		if len(advertised) > 1 {
			lastSeq = advertised[1]
		}
		if err = ws.Write(ctx, websocket.MessageBinary, collab.EncodeHello(uint64(e.source.ID), clientID, lastSeq)); err != nil {
			t.Fatal(err)
		}
		readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, raw, err := ws.Read(readCtx)
		if err != nil {
			t.Fatal(err)
		}
		msg, err := collab.DecodeServerMsg(raw)
		if err != nil {
			t.Fatal(err)
		}
		return ws, msg
	}
	assertView := func(msg collab.ServerMsg) {
		t.Helper()
		if msg.Type != collab.MsgWelcome && msg.Type != collab.MsgProjection {
			t.Fatalf("unexpected frame: %+v", msg)
		}
		if msg.Type == collab.MsgWelcome && (!msg.HasMode || !msg.ReadOnly || !msg.HasSnap || msg.SnapSeq != msg.HeadSeq) {
			t.Fatalf("unsafe welcome: %+v", msg)
		}
		if bytes.Contains(msg.State, []byte("🦄")) || bytes.Contains(msg.State, []byte(secret)) {
			t.Fatal("historical payload reached viewer")
		}
		projected, err := collab.DecodeState(msg.State)
		if err != nil {
			t.Fatal(err)
		}
		if projected.HasBlock(hidden.ID) || !strings.Contains(projected.Text(collab.OpID{Client: 0, Clock: 2}), "当前内容") {
			t.Fatalf("bad projection: %+v", projected.View())
		}
	}
	viewer, initial := connect(e.guest, "?protocol=3")
	assertView(initial)
	otherViewer, distinct := connect(e.guest, "?protocol=3", initial.ClientID, initial.HeadSeq)
	if distinct.ClientID == initial.ClientID {
		t.Fatal("view connection reused an editing or another viewer's ACK identity")
	}
	otherViewer.CloseNow()
	editor, editable := connect(e.owner, "?protocol=3")
	if !editable.HasMode || editable.ReadOnly || !editable.HasSnap {
		t.Fatalf("editor welcome: %+v", editable)
	}
	editorDoc, err := collab.DecodeState(editable.State)
	if err != nil {
		t.Fatal(err)
	}
	op := editorDoc.InsertText(editable.ClientID, collab.OpID{Client: 0, Clock: 2}, 4, "实时")
	batch, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	if err = editor.Write(ctx, websocket.MessageBinary, collab.EncodeClientOps(batch)); err != nil {
		t.Fatal(err)
	}
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, raw, err := viewer.Read(readCtx)
	if err != nil {
		t.Fatal(err)
	}
	update, err := collab.DecodeServerMsg(raw)
	if err != nil {
		t.Fatal(err)
	}
	assertView(update)
	updated, err := collab.DecodeState(update.State)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(updated.Text(collab.OpID{Client: 0, Clock: 2}), "实时") {
		t.Fatalf("missing live update: %+v", updated.View())
	}
	head, err := e.store.Head(ctx, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	forged := updated.InsertText(initial.ClientID, collab.OpID{Client: 0, Clock: 2}, 0, "不允许")
	batch, _ = collab.EncodeOps([]collab.Op{forged})
	if err = viewer.Write(ctx, websocket.MessageBinary, collab.EncodeClientOps(batch)); err != nil {
		t.Fatal(err)
	}
	_, _, _ = viewer.Read(readCtx)
	if after, _ := e.store.Head(ctx, e.source.ID); after != head {
		t.Fatalf("viewer wrote %d -> %d", head, after)
	}
	old, _, err := websocket.Dial(ctx, strings.Replace(ts.URL, "http", "ws", 1)+"/api/sync?protocol=2", &websocket.DialOptions{HTTPClient: e.guest})
	if err != nil {
		t.Fatal(err)
	}
	defer old.CloseNow()
	if err = old.Write(ctx, websocket.MessageBinary, collab.EncodeHello(uint64(e.source.ID), 0, 0)); err != nil {
		t.Fatal(err)
	}
	_, raw, err = old.Read(readCtx)
	if err == nil {
		msg, decodeErr := collab.DecodeServerMsg(raw)
		if decodeErr != nil || msg.Type != collab.MsgError || msg.Code != "upgrade_required" {
			t.Fatalf("legacy viewer received data: %s %+v %v", fmt.Sprintf("%x", raw), msg, decodeErr)
		}
	}
	// An editor downgraded while its socket is open must not receive a queued
	// raw CRDT update; reconnecting as a viewer obtains a projection instead.
	if err = e.store.SetShare(ctx, e.source.ID, e.guestUser.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	downgraded, editingGuest := connect(e.guest, "?protocol=3")
	if editingGuest.ReadOnly || !editingGuest.HasMode {
		t.Fatalf("guest not in edit mode: %+v", editingGuest)
	}
	guestDraftDoc, err := collab.DecodeState(editingGuest.State)
	if err != nil {
		t.Fatal(err)
	}
	draft := guestDraftDoc.InsertText(editingGuest.ClientID, collab.OpID{Client: 0, Clock: 2}, len([]rune(guestDraftDoc.Text(collab.OpID{Client: 0, Clock: 2}))), "离线草稿")
	if err = e.store.SetShare(ctx, e.source.ID, e.guestUser.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	change := editorDoc.InsertText(editable.ClientID, collab.OpID{Client: 0, Clock: 2}, len([]rune(editorDoc.Text(collab.OpID{Client: 0, Clock: 2}))), "变化")
	batch, _ = collab.EncodeOps([]collab.Op{change})
	if err = editor.Write(ctx, websocket.MessageBinary, collab.EncodeClientOps(batch)); err != nil {
		t.Fatal(err)
	}
	readDowngrade, stopDowngrade := context.WithTimeout(ctx, 5*time.Second)
	defer stopDowngrade()
	if _, raw, err = downgraded.Read(readDowngrade); err == nil {
		t.Fatalf("downgraded editor received raw frame: %x", raw)
	}
	viewerAgain, viewWelcome := connect(e.guest, "?protocol=3", editingGuest.ClientID, editingGuest.HeadSeq)
	assertView(viewWelcome)
	if viewWelcome.ClientID == editingGuest.ClientID {
		t.Fatal("view mode reused the offline editor's ACK identity")
	}
	newView, err := collab.DecodeState(viewWelcome.State)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(newView.Text(collab.OpID{Client: 0, Clock: 2}), "变化") {
		t.Fatal("viewer reconnect missed the change")
	}
	// An upgraded viewer reconnects before authoring so it cannot send edits
	// based on the intentionally incomplete projected state.
	if err = e.store.SetShare(ctx, e.source.ID, e.guestUser.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err = viewerAgain.Write(ctx, websocket.MessageBinary, collab.EncodeClientAware(`{"name":"reader"}`)); err != nil {
		t.Fatal(err)
	}
	readUpgrade, stopUpgrade := context.WithTimeout(ctx, 5*time.Second)
	defer stopUpgrade()
	if _, raw, err = viewerAgain.Read(readUpgrade); err == nil {
		t.Fatalf("upgraded viewer remained on projection transport: %x", raw)
	}
	upgradedSocket, upgraded := connect(e.guest, "?protocol=3", viewWelcome.ClientID, viewWelcome.HeadSeq)
	if !upgraded.HasMode || upgraded.ReadOnly || !bytes.Contains(upgraded.State, []byte("🦄")) {
		t.Fatalf("editor did not receive full state after upgrade: %+v", upgraded)
	}
	batch, err = collab.EncodeOps([]collab.Op{draft})
	if err != nil {
		t.Fatal(err)
	}
	if err = upgradedSocket.Write(ctx, websocket.MessageBinary, collab.EncodeClientOps(batch)); err != nil {
		t.Fatal(err)
	}
	readDraft, stopDraft := context.WithTimeout(ctx, 5*time.Second)
	defer stopDraft()
	_, raw, err = upgradedSocket.Read(readDraft)
	if err != nil {
		t.Fatal(err)
	}
	ack, err := collab.DecodeServerMsg(raw)
	if err != nil || ack.Type != collab.MsgSAck || ack.Count != 1 {
		t.Fatalf("old replica draft not accepted: %+v %v", ack, err)
	}
	final, _, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(final.Text(collab.OpID{Client: 0, Clock: 2}), "离线草稿") {
		t.Fatal("retained draft missing after upgrade")
	}
}

func TestReadOnlySyncFailsClosedOnAmbiguousTable(t *testing.T) {
	ctx := context.Background()
	e := newCopyTestEnv(t)
	e.share(t)
	doc, _, err := StateAtHead(ctx, e.store, e.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	block := doc.CreateBlock(25, collab.Root, "Z", "table")
	value := "2"
	set := collab.Op{T: collab.TBlockSet, ID: collab.OpID{Client: 25, Clock: doc.Clock() + 1}, Block: block.ID, Key: "tbl.v", Value: &value}
	doc.Apply(set)
	for _, op := range []collab.Op{block, set} {
		encoded, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = e.store.AppendOps(ctx, e.source.ID, []store.RawOp{{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: encoded}}); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{Store: e.store, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100, Hub: &syncsrv.Hub{Store: e.store, PingInterval: time.Hour}}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	ws, _, err := websocket.Dial(ctx, strings.Replace(ts.URL, "http", "ws", 1)+"/api/sync?protocol=3", &websocket.DialOptions{HTTPClient: e.guest})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if err = ws.Write(ctx, websocket.MessageBinary, collab.EncodeHello(uint64(e.source.ID), 0, 0)); err != nil {
		t.Fatal(err)
	}
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, raw, err := ws.Read(readCtx)
	if err != nil {
		t.Fatal(err)
	}
	msg, err := collab.DecodeServerMsg(raw)
	if err != nil || msg.Type != collab.MsgError || msg.Code != "projection_unavailable" {
		t.Fatalf("expected safe rejection, got %+v %v", msg, err)
	}
}
