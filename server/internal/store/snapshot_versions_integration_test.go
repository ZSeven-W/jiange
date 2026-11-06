package store_test

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

// Exercise the same version snapshot contract in memory and Postgres, including
// the actual WebSocket path used by a replica reconnecting from before it.
func checkNamedSnapshotRecovery(t *testing.T, st store.Store) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	user, ws, err := st.CreateUser(ctx, "snapshot-versions@example.test", "Snapshot", "hash")
	if err != nil {
		t.Fatal(err)
	}
	meta, err := st.CreateDoc(ctx, ws.ID, user.ID, nil, "演示", syncsrv.InitialOps("演示"))
	if err != nil {
		t.Fatal(err)
	}
	rows, err := st.OpsAfter(ctx, meta.ID, 0, 1000)
	if err != nil || len(rows) == 0 {
		t.Fatalf("initial ops: %d %v", len(rows), err)
	}
	state := collab.NewDoc()
	for _, row := range rows {
		ops, err := collab.DecodeOps(row.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		for _, op := range ops {
			state.Apply(op)
		}
	}
	head, err := st.Head(ctx, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	encoded := state.EncodeState()
	original := bytes.Clone(encoded)
	if err := st.SaveSnapshot(ctx, meta.ID, head, encoded); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveVersion(ctx, meta.ID, head, "初稿", user.ID); err != nil {
		t.Fatal(err)
	}
	// Callers must not be able to mutate a saved snapshot by changing input or
	// returned buffers. A conflicting save must not overwrite a named version.
	encoded[0] ^= 0xff
	seq, read, err := st.LatestSnapshot(ctx, meta.ID)
	if err != nil || seq != head || !bytes.Equal(read, original) {
		t.Fatalf("named snapshot: seq=%d want=%d err=%v", seq, head, err)
	}
	read[0] ^= 0xff
	if err := st.SaveSnapshot(ctx, meta.ID, head, []byte("different")); err != nil {
		t.Fatal(err)
	}
	version, err := st.VersionState(ctx, meta.ID, head)
	if err != nil || !bytes.Equal(version, original) {
		t.Fatalf("named version changed: %v", err)
	}
	version[0] ^= 0xff
	_, version, err = st.LatestSnapshot(ctx, meta.ID)
	if err != nil || !bytes.Equal(version, original) {
		t.Fatalf("returned state aliased store: %v", err)
	}
	versions, err := st.Versions(ctx, meta.ID)
	if err != nil || len(versions) != 1 || versions[0].Seq != head || versions[0].Label != "初稿" {
		t.Fatalf("versions: %+v %v", versions, err)
	}

	replica, err := st.AllocClient(ctx, user.ID, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	paragraph := collab.OpID{Client: 0, Clock: 2}
	op := state.InsertText(uint64(replica), paragraph, 0, "之后的修改")
	batch, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendOps(ctx, meta.ID, []store.RawOp{{ClientID: replica, Clock: int64(op.ID.Clock), Bytes: batch}}); err != nil {
		t.Fatal(err)
	}
	newHead, err := st.Head(ctx, meta.ID)
	if err != nil || newHead != head+1 {
		t.Fatalf("head=%d err=%v", newHead, err)
	}

	hub := &syncsrv.Hub{Store: st}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hub.Serve(w, r, user, nil) }))
	defer server.Close()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(ctx, websocket.MessageBinary, collab.EncodeHello(uint64(meta.ID), 0, 0)); err != nil {
		t.Fatal(err)
	}
	_, welcomeBytes, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	welcome, err := collab.DecodeServerMsg(welcomeBytes)
	if err != nil || welcome.Type != collab.MsgWelcome || !welcome.HasSnap || welcome.SnapSeq != uint64(head) || welcome.HeadSeq != uint64(newHead) {
		t.Fatalf("reconnect welcome: %+v %v", welcome, err)
	}
	rebuilt, err := collab.DecodeState(welcome.State)
	if err != nil {
		t.Fatal(err)
	}
	_, deltaBytes, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	delta, err := collab.DecodeServerMsg(deltaBytes)
	if err != nil || delta.Type != collab.MsgSOps || delta.FirstSeq != uint64(head+1) {
		t.Fatalf("reconnect delta: %+v %v", delta, err)
	}
	ops, err := collab.DecodeOps(delta.Batch)
	if err != nil {
		t.Fatal(err)
	}
	for _, op := range ops {
		rebuilt.Apply(op)
	}
	if got := rebuilt.Text(paragraph); got != "之后的修改" {
		t.Fatalf("reconnected text = %q", got)
	}

	if err := st.SaveSnapshot(ctx, meta.ID, newHead, state.EncodeState()); err != nil {
		t.Fatal(err)
	}
	if seq, _, err := st.LatestSnapshot(ctx, meta.ID); err != nil || seq != newHead {
		t.Fatalf("newer snapshot = %d: %v", seq, err)
	}
	if saved, err := st.VersionState(ctx, meta.ID, head); err != nil || !bytes.Equal(saved, original) {
		t.Fatalf("older named version lost: %v", err)
	}
}

func TestMemoryNamedSnapshotRemainsSyncBaseline(t *testing.T) {
	checkNamedSnapshotRecovery(t, store.NewMemory())
}

func TestPostgresNamedSnapshotRemainsSyncBaseline(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_snapshot_%d", time.Now().UnixNano())
	name := pgx.Identifier{schema}.Sanitize()
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+name+" CASCADE")
		admin.Close()
	}()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+name); err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	checkNamedSnapshotRecovery(t, &store.Postgres{Pool: pool})
}
