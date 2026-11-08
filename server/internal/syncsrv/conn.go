package syncsrv

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	maxAwareness = 4096
	ackFlushGap  = 50
)

type conn struct {
	hub    *Hub
	ws     *websocket.Conn
	user   store.User
	out    chan []byte
	cancel context.CancelFunc
	docID  atomic.Int64 // set before join queues the first document frame
	// authenticate revalidates the session that originally opened this
	// connection. Test-only callers may leave it nil when not using sessions.
	authenticate func(context.Context) error

	// guarded by room.mu once joined
	room     *room
	clientID uint64
	acked    int64
	// wantsV2 is explicit client capability on the WebSocket URL. Older servers
	// ignore it and still speak v1; older clients never send it.
	wantsV2 bool
	// Only negotiated v2 peers may carry newer op kinds such as ttable.
	v2      bool
	dbAcked int64
	aware   string
	owned   map[uint64]bool // replica ids this user may author ops for (read loop only)
	closed  bool
}

// send queues a frame; a client that can't keep up is disconnected rather
// than letting the room block or buffer without bound.
func (c *conn) send(b []byte) {
	if c.closed {
		return
	}
	select {
	case c.out <- b:
	default:
		c.closed = true
		c.cancel()
	}
}

// writeLoop runs until stop ends; conn (the read side) is used to abort writes.
func (c *conn) writeLoop(stop, ctx context.Context) {
	ping := time.NewTicker(c.hub.PingInterval)
	defer ping.Stop()
	for {
		select {
		case <-stop.Done():
			return
		case <-ctx.Done():
			return
		case b := <-c.out:
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			// Permission can change while a message is waiting in the queue. Check
			// immediately before sending, including for cross-instance broadcasts.
			// A storage failure is treated as a denial, never as cached access.
			_, err := c.currentRole(wctx)
			if err == nil {
				err = c.ws.Write(wctx, websocket.MessageBinary, b)
			}
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			_, err := c.currentRole(pctx)
			if err == nil {
				err = c.ws.Ping(pctx)
			}
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
}

func (c *conn) fail(code, msg string) {
	c.out <- collab.EncodeError(code, msg) // best effort; writer drains before close
}

func (c *conn) readLoop(ctx context.Context) error {
	hctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	typ, b, err := c.ws.Read(hctx)
	cancel()
	if err != nil {
		return err
	}
	m, err := collab.DecodeClientMsg(b)
	if err != nil || typ != websocket.MessageBinary || m.Type != collab.MsgHello {
		c.fail("bad_hello", "first message must be HELLO")
		return errors.New("bad hello")
	}
	if err := c.hello(ctx, m); err != nil {
		return err
	}
	for {
		typ, b, err := c.ws.Read(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageBinary {
			continue
		}
		m, err := collab.DecodeClientMsg(b)
		if err != nil {
			c.room.sendErr(c, "bad_message", err.Error())
			continue
		}
		checkCtx, stopCheck := context.WithTimeout(ctx, 10*time.Second)
		role, err := c.currentRole(checkCtx)
		stopCheck()
		if err != nil {
			// Stop processing all traffic (including awareness) after revocation.
			return err
		}
		switch m.Type {
		case collab.MsgOps:
			ops, err := collab.DecodeOps(m.Batch)
			if err != nil {
				c.room.sendErr(c, "bad_ops", err.Error())
				return errors.New("invalid ops batch")
			}
			if store.RoleRank(role) < store.RoleRank(store.RoleEdit) {
				c.room.sendErr(c, "read_only", "you can only view this document")
				return errors.New("read-only ops batch")
			}
			if !c.mayAuthor(ctx, ops) {
				c.room.sendErr(c, "forbidden", "ops authored by a replica you don't own")
				return errors.New("forbidden ops")
			}
			if err := c.room.handleOps(ctx, c, ops); err != nil {
				return err
			}
		case collab.MsgAck:
			c.room.handleAck(ctx, c, int64(m.Seq))
		case collab.MsgAware:
			if len(m.State) > maxAwareness {
				c.room.sendErr(c, "too_large", "awareness state too large")
				continue
			}
			c.room.handleAware(c, m.State)
		default:
			c.room.sendErr(c, "bad_message", "unexpected message type")
		}
	}
}

func (c *conn) hello(ctx context.Context, m collab.ClientMsg) error {
	if _, err := c.currentRole(ctx); err != nil {
		return err
	}
	st := c.hub.Store
	doc := int64(m.DocID)
	meta, err := st.GetDoc(ctx, c.user.ID, doc)
	if err == nil && meta.Kind != "doc" {
		err = store.ErrNotFound
	}
	if err != nil {
		c.fail("not_found", "document not found")
		return err
	}
	c.docID.Store(doc)
	c.v2 = m.HasEpoch || c.wantsV2
	id := int64(m.ClientID)
	if id != 0 {
		if uid, d, err := st.ClientOwner(ctx, id); err != nil || uid != c.user.ID || d != doc {
			id = 0 // unknown or foreign id: issue a fresh one
		}
	}
	if id == 0 {
		var err error
		if id, err = st.AllocClient(ctx, c.user.ID, doc); err != nil {
			c.fail("internal", "could not allocate client id")
			return err
		}
	}
	c.clientID = uint64(id)
	c.owned[c.clientID] = true
	if m.ClientID != 0 && m.ClientID != c.clientID {
		// pending ops from the old id may only be resent if that id is ours too
		if uid, oldDoc, err := st.ClientOwner(ctx, int64(m.ClientID)); err == nil && uid == c.user.ID && oldDoc == doc {
			c.owned[m.ClientID] = true
		}
	}
	c.room = c.hub.room(doc)
	epoch, _, err := st.HeadVersion(ctx, doc)
	if err != nil {
		c.fail("internal", "could not read document history generation")
		return err
	}
	if epoch < 1 {
		c.fail("internal", "invalid document history generation")
		return errors.New("invalid document history generation")
	}
	// An epoch-less client upgrading from v1 has no trustworthy sequence for
	// this generation. Zero forces replay instead of acknowledging stale state.
	return c.room.join(ctx, c, int64(helloLastSeq(c.v2, m.HistoryEpoch, uint64(epoch), m.LastSeq)), c.v2, uint64(epoch))
}

// helloLastSeq decides how far the server may replay for a v2 client: seqs
// cached under a different history generation are meaningless (restore/PITR),
// so the client is reset to a full snapshot resync; its pending drafts retry
// by operation identity.
func helloLastSeq(clientHasEpoch bool, clientEpoch, serverEpoch, lastSeq uint64) uint64 {
	if clientHasEpoch && clientEpoch != serverEpoch {
		return 0
	}
	return lastSeq
}

// currentRole is checked on every incoming frame and immediately before each
// outgoing frame. No document has been joined while the first HELLO is read.
func (c *conn) currentRole(ctx context.Context) (string, error) {
	if c.authenticate != nil {
		if err := c.authenticate(ctx); err != nil {
			return "", err
		}
	}
	id := c.docID.Load()
	if id == 0 {
		return "", nil
	}
	meta, err := c.hub.Store.GetDoc(ctx, c.user.ID, id)
	if err != nil {
		return "", err
	}
	if meta.Kind != "doc" || store.RoleRank(meta.Role) < store.RoleRank(store.RoleView) {
		return "", store.ErrNotFound
	}
	return meta.Role, nil
}

// mayAuthor checks every op is stamped with a replica id issued to this user for this doc.
func (c *conn) mayAuthor(ctx context.Context, ops []collab.Op) bool {
	for _, op := range ops {
		id := op.ID.Client
		if c.owned[id] {
			continue
		}
		uid, doc, err := c.hub.Store.ClientOwner(ctx, int64(id))
		if err != nil || uid != c.user.ID || doc != c.room.id {
			return false
		}
		c.owned[id] = true
	}
	return true
}
