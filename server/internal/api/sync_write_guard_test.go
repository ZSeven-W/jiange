package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
	"github.com/coder/websocket"
)

type beforeSocketCommitStore struct {
	store.Store
	once   sync.Once
	before func(store.RestoreGuard) error
	result chan error
}

func (s *beforeSocketCommitStore) AppendOpsAtHeadGuarded(ctx context.Context, guard store.RestoreGuard, doc, head int64, ops []store.RawOp) ([]int64, error) {
	s.once.Do(func() { s.result <- s.before(guard) })
	return s.Store.AppendOpsAtHeadGuarded(ctx, guard, doc, head, ops)
}

func TestDocumentSocketRechecksOriginalSessionAtCommit(t *testing.T) {
	for _, event := range []string{"permission", "session"} {
		t.Run(event, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			base := store.NewMemory()
			wrapped := &beforeSocketCommitStore{Store: base, result: make(chan error, 1)}
			s := &Server{Store: wrapped, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour, Iterations: 1000, Hub: &syncsrv.Hub{Store: wrapped, PingInterval: time.Hour}}
			ts := httptest.NewServer(s.Handler())
			defer ts.Close()
			ownerJar, _ := cookiejar.New(nil)
			editorJar, _ := cookiejar.New(nil)
			owner, editor := &http.Client{Jar: ownerJar}, &http.Client{Jar: editorJar}
			post(t, owner, ts.URL+"/api/auth/register", map[string]string{"email": "socket-owner@test.dev", "name": "Owner", "password": "password123"})
			post(t, editor, ts.URL+"/api/auth/register", map[string]string{"email": "socket-editor@test.dev", "name": "Editor", "password": "password123"})
			var meta store.DocMeta
			if err := json.NewDecoder(post(t, owner, ts.URL+"/api/docs", map[string]string{"title": ""}).Body).Decode(&meta); err != nil {
				t.Fatal(err)
			}
			user, err := base.UserByEmail(ctx, "socket-editor@test.dev")
			if err != nil {
				t.Fatal(err)
			}
			if err = base.SetShare(ctx, meta.ID, user.ID, store.RoleEdit); err != nil {
				t.Fatal(err)
			}
			wrapped.before = func(guard store.RestoreGuard) error {
				if event == "session" {
					return base.DeleteSession(ctx, guard.SessionHash)
				}
				return base.SetShare(ctx, meta.ID, user.ID, "")
			}
			ws, _, err := websocket.Dial(ctx, strings.Replace(ts.URL, "http", "ws", 1)+"/api/sync", &websocket.DialOptions{HTTPClient: editor})
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			if err = ws.Write(ctx, websocket.MessageBinary, collab.EncodeHello(uint64(meta.ID), 0, 0)); err != nil {
				t.Fatal(err)
			}
			doc := collab.NewDoc()
			var clientID, head, caught uint64
			for clientID == 0 || caught < head {
				_, data, e := ws.Read(ctx)
				if e != nil {
					t.Fatal(e)
				}
				msg, e := collab.DecodeServerMsg(data)
				if e != nil {
					t.Fatal(e)
				}
				switch msg.Type {
				case collab.MsgWelcome:
					clientID, head = msg.ClientID, msg.HeadSeq
				case collab.MsgSOps:
					ops, e := collab.DecodeOps(msg.Batch)
					if e != nil {
						t.Fatal(e)
					}
					for _, op := range ops {
						doc.Apply(op)
					}
					caught = msg.FirstSeq + uint64(len(ops)) - 1
				}
			}
			op := doc.InsertText(clientID, collab.OpID{Client: 0, Clock: 2}, 0, "must not commit")
			batch, err := collab.EncodeOps([]collab.Op{op})
			if err != nil {
				t.Fatal(err)
			}
			if err = ws.Write(ctx, websocket.MessageBinary, collab.EncodeClientOps(batch)); err != nil {
				t.Fatal(err)
			}
			if err = <-wrapped.result; err != nil {
				t.Fatal(err)
			}
			for {
				_, data, e := ws.Read(ctx)
				if e != nil {
					break
				}
				msg, e := collab.DecodeServerMsg(data)
				if e != nil {
					t.Fatal(e)
				}
				if msg.Type == collab.MsgSAck {
					t.Fatal("revoked operation acknowledged")
				}
			}
			if ctx.Err() != nil {
				t.Fatal("revoked connection did not close")
			}
			if actual, e := base.Head(ctx, meta.ID); e != nil || actual != int64(head) {
				t.Fatalf("revoked operation changed head: %d -> %d (%v)", head, actual, e)
			}
		})
	}
}
