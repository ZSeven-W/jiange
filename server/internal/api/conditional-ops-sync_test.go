package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
	"github.com/coder/websocket"
)

type observedConditionalStore struct {
	store.Store
	store.ConditionalOpsCommitter
	ready chan struct{}
	once  sync.Once
}

func (s *observedConditionalStore) Listen(ctx context.Context, fn func(int64, int64)) error {
	return s.Store.Listen(ctx, func(doc, head int64) { s.once.Do(func() { close(s.ready) }); fn(doc, head) })
}

func checkConditionalOpsBroadcast(t *testing.T, base store.Store, committer store.ConditionalOpsCommitter) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	st := &observedConditionalStore{Store: base, ConditionalOpsCommitter: committer, ready: make(chan struct{})}
	hub := &syncsrv.Hub{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), PingInterval: time.Hour}
	go func() { _ = hub.Run(ctx) }()
	s := &Server{Store: st, Hub: hub, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 100}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	r := post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "conditional-broadcast@test.dev", "name": "Tester", "password": "password123"})
	var me struct {
		User store.User `json:"user"`
	}
	_ = json.NewDecoder(r.Body).Decode(&me)
	r.Body.Close()
	r = post(t, client, ts.URL+"/api/docs", map[string]string{"title": "同步"})
	var doc store.DocMeta
	_ = json.NewDecoder(r.Body).Decode(&doc)
	r.Body.Close()
	probe, err := base.AllocClient(ctx, me.User.ID, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Confirm that the listener received a real store notification before the
	// conditional request. This avoids relying on scheduler timing.
	for i := 0; ; i++ {
		select {
		case <-st.ready:
			goto listening
		case <-ctx.Done():
			t.Fatal("store listener did not start")
		default:
		}
		state, _, err := StateAtHead(ctx, base, doc.ID)
		if err != nil {
			t.Fatal(err)
		}
		op := state.CreateBlock(uint64(probe), collab.Root, "Z", "paragraph")
		encoded, _ := collab.EncodeOps([]collab.Op{op})
		if _, err = base.AppendOps(ctx, doc.ID, []store.RawOp{{ClientID: probe, Clock: int64(op.ID.Clock), Bytes: encoded}}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-st.ready:
			goto listening
		case <-ctx.Done():
			t.Fatal("store listener did not start")
		case <-time.After(5 * time.Millisecond):
		}
	}
listening:
	ws, _, err := websocket.Dial(ctx, strings.Replace(ts.URL, "http", "ws", 1)+"/api/sync", &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if err = ws.Write(ctx, websocket.MessageBinary, collab.EncodeHello(uint64(doc.ID), 0, 0)); err != nil {
		t.Fatal(err)
	}
	var replica, head, caught uint64
	for replica == 0 || caught < head {
		_, data, err := ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		msg, err := collab.DecodeServerMsg(data)
		if err != nil {
			t.Fatal(err)
		}
		switch msg.Type {
		case collab.MsgWelcome:
			replica, head = msg.ClientID, msg.HeadSeq
			if msg.HasSnap {
				caught = msg.SnapSeq
			}
		case collab.MsgSOps:
			ops, err := collab.DecodeOps(msg.Batch)
			if err != nil {
				t.Fatal(err)
			}
			caught = msg.FirstSeq + uint64(len(ops)) - 1
		}
	}
	epoch, currentHead, err := base.HeadVersion(ctx, doc.ID)
	if err != nil || currentHead != int64(head) {
		t.Fatalf("head: %d %d %v", currentHead, head, err)
	}
	state, _, err := StateAtHead(ctx, base, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	op := state.InsertText(replica, collab.OpID{Client: 0, Clock: 2}, 0, "同步")
	batch, _ := collab.EncodeOps([]collab.Op{op})
	body, _ := json.Marshal(conditionalOpsInput{epoch, currentHead, "aaaaaaaa00000000bbbbbbbb11111111", batch})
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/docs/"+strconv.FormatInt(doc.ID, 10)+"/conditional-ops", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Jiange-User-Id", strconv.FormatInt(me.User.ID, 10))
	r, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(r.Body)
		t.Fatalf("conditional request: %d %s", r.StatusCode, data)
	}
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("waiting for broadcast: %v", err)
		}
		msg, err := collab.DecodeServerMsg(data)
		if err != nil {
			t.Fatal(err)
		}
		if msg.Type != collab.MsgSOps {
			continue
		}
		ops, err := collab.DecodeOps(msg.Batch)
		if err != nil || msg.FirstSeq != head+1 || len(ops) != 1 || ops[0].Text != "同步" {
			t.Fatalf("broadcast: %+v %v", msg, err)
		}
		break
	}
}

func TestConditionalOpsBroadcast(t *testing.T) {
	st := store.NewMemory()
	checkConditionalOpsBroadcast(t, st, st)
}

func TestPostgresConditionalOpsBroadcast(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	pg, err := store.NewPostgres(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err = migrate.Up(context.Background(), pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkConditionalOpsBroadcast(t, pg, pg)
}
