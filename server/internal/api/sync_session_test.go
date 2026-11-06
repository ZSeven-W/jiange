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
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

func TestDocumentSocketRejectsRevokedSession(t *testing.T) {
	for _, mode := range []string{"logout", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			st := store.NewMemory()
			var now atomic.Int64
			now.Store(time.Now().UnixNano())
			s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
				SessionTTL: time.Hour, Iterations: 1000, Now: func() time.Time { return time.Unix(0, now.Load()) },
				Hub: &syncsrv.Hub{Store: st, PingInterval: time.Hour}}
			ts := httptest.NewServer(s.Handler())
			defer ts.Close()
			jar, _ := cookiejar.New(nil)
			client := &http.Client{Jar: jar}
			post(t, client, ts.URL+"/api/auth/register", map[string]string{"email": "k@example.com", "name": "K", "password": "password123"})
			res := post(t, client, ts.URL+"/api/docs", map[string]string{"title": ""})
			var meta store.DocMeta
			if err := json.NewDecoder(res.Body).Decode(&meta); err != nil {
				t.Fatal(err)
			}
			if err := res.Body.Close(); err != nil {
				t.Fatal(err)
			}

			ws, _, err := websocket.Dial(t.Context(), strings.Replace(ts.URL, "http", "ws", 1)+"/api/sync", &websocket.DialOptions{HTTPClient: client})
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			if err := ws.Write(t.Context(), websocket.MessageBinary, collab.EncodeHello(uint64(meta.ID), 0, 0)); err != nil {
				t.Fatal(err)
			}
			doc := collab.NewDoc()
			var clientID, head, caught uint64
			for clientID == 0 || caught < head {
				_, data, err := ws.Read(t.Context())
				if err != nil {
					t.Fatal(err)
				}
				msg, err := collab.DecodeServerMsg(data)
				if err != nil {
					t.Fatal(err)
				}
				switch msg.Type {
				case collab.MsgWelcome:
					clientID, head = msg.ClientID, msg.HeadSeq
				case collab.MsgSOps:
					ops, err := collab.DecodeOps(msg.Batch)
					if err != nil {
						t.Fatal(err)
					}
					for _, op := range ops {
						doc.Apply(op)
					}
					caught = msg.FirstSeq + uint64(len(ops)) - 1
				}
			}
			paragraph := collab.OpID{Client: 0, Clock: 2}
			write := func(text string, offset int) {
				t.Helper()
				op := doc.InsertText(clientID, paragraph, offset, text)
				batch, err := collab.EncodeOps([]collab.Op{op})
				if err != nil {
					t.Fatal(err)
				}
				if err := ws.Write(t.Context(), websocket.MessageBinary, collab.EncodeClientOps(batch)); err != nil {
					t.Fatal(err)
				}
			}
			write("valid", 0)
			_, data, err := ws.Read(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			ack, err := collab.DecodeServerMsg(data)
			if err != nil || ack.Type != collab.MsgSAck || ack.Count != 1 {
				t.Fatalf("valid session did not write: %+v %v", ack, err)
			}
			before, err := st.Head(t.Context(), meta.ID)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "logout" {
				res := post(t, client, ts.URL+"/api/auth/logout", nil)
				if res.StatusCode != http.StatusNoContent {
					t.Fatalf("logout: %d", res.StatusCode)
				}
				res.Body.Close()
			} else {
				now.Add(int64(2 * time.Hour))
			}
			write("rejected", 5)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			if _, _, err := ws.Read(ctx); err == nil {
				t.Fatal("socket accepted a message after session revocation")
			}
			after, err := st.Head(t.Context(), meta.ID)
			if err != nil {
				t.Fatal(err)
			}
			if after != before {
				t.Fatalf("operation persisted after %s: %d -> %d", mode, before, after)
			}
		})
	}
}

func TestDocumentSocketDoesNotBroadcastAfterLogout(t *testing.T) {
	st := store.NewMemory()
	s := &Server{Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), SessionTTL: time.Hour,
		Iterations: 1000, Hub: &syncsrv.Hub{Store: st, PingInterval: time.Hour}}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	jar1, _ := cookiejar.New(nil)
	client1 := &http.Client{Jar: jar1}
	post(t, client1, ts.URL+"/api/auth/register", map[string]string{"email": "k@example.com", "name": "K", "password": "password123"})
	res := post(t, client1, ts.URL+"/api/docs", map[string]string{"title": ""})
	var meta store.DocMeta
	if err := json.NewDecoder(res.Body).Decode(&meta); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	jar2, _ := cookiejar.New(nil)
	client2 := &http.Client{Jar: jar2}
	res = post(t, client2, ts.URL+"/api/auth/login", map[string]string{"email": "k@example.com", "password": "password123"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("login: %d", res.StatusCode)
	}
	res.Body.Close()

	connect := func(client *http.Client) (*websocket.Conn, uint64, *collab.Doc) {
		t.Helper()
		ws, _, err := websocket.Dial(t.Context(), strings.Replace(ts.URL, "http", "ws", 1)+"/api/sync", &websocket.DialOptions{HTTPClient: client})
		if err != nil {
			t.Fatal(err)
		}
		if err := ws.Write(t.Context(), websocket.MessageBinary, collab.EncodeHello(uint64(meta.ID), 0, 0)); err != nil {
			t.Fatal(err)
		}
		doc := collab.NewDoc()
		var clientID, head, caught uint64
		for clientID == 0 || caught < head {
			_, data, err := ws.Read(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			msg, err := collab.DecodeServerMsg(data)
			if err != nil {
				t.Fatal(err)
			}
			switch msg.Type {
			case collab.MsgWelcome:
				clientID, head = msg.ClientID, msg.HeadSeq
			case collab.MsgSOps:
				ops, err := collab.DecodeOps(msg.Batch)
				if err != nil {
					t.Fatal(err)
				}
				for _, op := range ops {
					doc.Apply(op)
				}
				caught = msg.FirstSeq + uint64(len(ops)) - 1
			}
		}
		return ws, clientID, doc
	}
	loggedOut, _, _ := connect(client1)
	defer loggedOut.CloseNow()
	active, activeID, activeDoc := connect(client2)
	defer active.CloseNow()
	res = post(t, client1, ts.URL+"/api/auth/logout", nil)
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("logout: %d", res.StatusCode)
	}
	res.Body.Close()
	op := activeDoc.InsertText(activeID, collab.OpID{Client: 0, Clock: 2}, 0, "private")
	batch, err := collab.EncodeOps([]collab.Op{op})
	if err != nil {
		t.Fatal(err)
	}
	if err := active.Write(t.Context(), websocket.MessageBinary, collab.EncodeClientOps(batch)); err != nil {
		t.Fatal(err)
	}
	_, data, err := active.Read(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	ack, err := collab.DecodeServerMsg(data)
	if err != nil || ack.Type != collab.MsgSAck || ack.Count != 1 {
		t.Fatalf("active session did not write: %+v %v", ack, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if _, _, err := loggedOut.Read(ctx); err == nil {
		t.Fatal("logged-out session received document broadcast")
	}
}
