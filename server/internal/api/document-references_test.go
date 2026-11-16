package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

func appendReference(t *testing.T, st store.Store, docID int64, href, text string, kind ...string) string {
	t.Helper()
	ctx := context.Background()
	d, _, err := StateAtHead(ctx, st, docID)
	if err != nil {
		t.Fatal(err)
	}
	block := d.CreateBlock(51, collab.Root, "z", "paragraph")
	inserted := d.InsertText(51, block.ID, 0, text)
	value := href
	mark := collab.Op{T: collab.TMark, ID: collab.OpID{Client: 51, Clock: d.Clock() + 1}, Block: block.ID, Key: "link", Value: &value, Start: collab.Anchor{Char: inserted.ID}, End: collab.Anchor{Char: collab.OpID{Client: inserted.ID.Client, Clock: inserted.ID.Clock + uint64(len([]rune(text))) - 1}, Side: 1}}
	if !d.Apply(mark) {
		t.Fatal("mark failed")
	}
	ops := []collab.Op{block, inserted, mark}
	if len(kind) > 0 {
		value := kind[0]
		kindMark := mark
		kindMark.ID = collab.OpID{Client: 51, Clock: d.Clock() + 1}
		kindMark.Key, kindMark.Value = "linkKind", &value
		if !d.Apply(kindMark) {
			t.Fatal("kind mark failed")
		}
		ops = append(ops, kindMark)
	}
	var rows []store.RawOp
	for _, op := range ops {
		raw, err := collab.EncodeOps([]collab.Op{op})
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, store.RawOp{ClientID: int64(op.ID.Client), Clock: int64(op.ID.Clock), Bytes: raw})
	}
	if _, err := st.AppendOps(ctx, docID, rows); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%d:%d", block.ID.Client, block.ID.Clock)
}

func TestDocumentReferencesExcludeManualTextLinks(t *testing.T) {
	e := newCopyTestEnv(t)
	ctx := context.Background()
	source, err := e.store.CreateDoc(ctx, e.ownerSpace.ID, e.ownerUser.ID, nil, "来源", syncsrv.InitialOps("来源"))
	if err != nil {
		t.Fatal(err)
	}
	href := fmt.Sprintf("#/doc/%d", e.source.ID)
	appendReference(t, e.store, source.ID, href, "普通文字链接", "text")
	guard := store.RestoreGuard{UserID: e.ownerUser.ID, SessionHash: []byte("reference-kind")}
	if err = e.store.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: e.store, Now: time.Now}
	result, err := server.scanDocumentReferences(ctx, guard, e.source.ID)
	if err != nil || len(result.Incoming) != 0 {
		t.Fatalf("manual link counted: %+v %v", result, err)
	}
	block := appendReference(t, e.store, source.ID, href, "文档引用", "reference")
	result, err = server.scanDocumentReferences(ctx, guard, e.source.ID)
	if err != nil || len(result.Incoming) != 1 || len(result.Incoming[0].Contexts) != 1 || result.Incoming[0].Contexts[0].Block != block {
		t.Fatalf("reference missing: %+v %v", result, err)
	}
}

func TestDocumentReferencesRequireAccessAndRespectCopyPolicy(t *testing.T) {
	e := newCopyTestEnv(t)
	ctx := context.Background()
	target := e.source
	create := func(name string) store.DocMeta {
		d, err := e.store.CreateDoc(ctx, e.ownerSpace.ID, e.ownerUser.ID, nil, name, syncsrv.InitialOps(name))
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	visible, hidden := create("有权来源"), create("不可见来源")
	block := appendReference(t, e.store, visible.ID, fmt.Sprintf("#/doc/%d?block=0%%3A2", target.ID), "参考项目方案")
	appendReference(t, e.store, hidden.ID, fmt.Sprintf("#/doc/%d", target.ID), "不应显示")
	appendReference(t, e.store, target.ID, fmt.Sprintf("#/doc/%d", visible.ID), "相关来源")
	e.share(t)
	if err := e.store.SetShare(ctx, visible.ID, e.guestUser.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: e.guestUser.ID, SessionHash: []byte("references-guest")}
	if err := e.store.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: e.store, Now: time.Now}
	result, err := server.scanDocumentReferences(ctx, guard, target.ID)
	if err != nil || len(result.Incoming) != 1 || len(result.Outgoing) != 1 || result.Incoming[0].ID != visible.ID || result.Outgoing[0].ID != visible.ID || len(result.Incoming[0].Contexts) != 1 || result.Incoming[0].Contexts[0].Block != block || result.Incoming[0].Contexts[0].Text != "参考项目方案" {
		t.Fatalf("references: %+v %v", result, err)
	}
	if err := e.store.SetCopyProtected(ctx, visible.ID, true); err != nil {
		t.Fatal(err)
	}
	result, err = server.scanDocumentReferences(ctx, guard, target.ID)
	if err != nil || len(result.Incoming) != 1 || result.Incoming[0].Contexts[0].Text != "" {
		t.Fatalf("protected excerpt: %+v %v", result, err)
	}
	if err := e.store.SetShare(ctx, visible.ID, e.guestUser.ID, ""); err != nil {
		t.Fatal(err)
	}
	result, err = server.scanDocumentReferences(ctx, guard, target.ID)
	if err != nil || len(result.Incoming) != 0 || len(result.Outgoing) != 0 {
		t.Fatalf("revoked source: %+v %v", result, err)
	}
	if err := e.store.SetShare(ctx, target.ID, e.guestUser.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = server.scanDocumentReferences(ctx, guard, target.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked target: %v", err)
	}
}

type referenceRecheckStore struct {
	store.Store
	source, user int64
	reads        int
	change       func()
}

func (s *referenceRecheckStore) GetDoc(ctx context.Context, uid, id int64) (store.DocMeta, error) {
	if uid == s.user && id == s.source {
		s.reads++
		if s.reads == 3 {
			s.change()
		}
	}
	return s.Store.GetDoc(ctx, uid, id)
}

func TestDocumentReferencesRecheckChangesDuringScan(t *testing.T) {
	for _, policy := range []string{"revoke", "protect"} {
		t.Run(policy, func(t *testing.T) {
			e := newCopyTestEnv(t)
			ctx := context.Background()
			source, err := e.store.CreateDoc(ctx, e.ownerSpace.ID, e.ownerUser.ID, nil, "来源", syncsrv.InitialOps("来源"))
			if err != nil {
				t.Fatal(err)
			}
			appendReference(t, e.store, source.ID, fmt.Sprintf("#/doc/%d", e.source.ID), "敏感引用")
			e.share(t)
			if err = e.store.SetShare(ctx, source.ID, e.guestUser.ID, store.RoleView); err != nil {
				t.Fatal(err)
			}
			guard := store.RestoreGuard{UserID: e.guestUser.ID, SessionHash: []byte("references-race")}
			if err = e.store.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			wrapped := &referenceRecheckStore{Store: e.store, source: source.ID, user: guard.UserID}
			wrapped.change = func() {
				if policy == "revoke" {
					_ = e.store.SetShare(ctx, source.ID, guard.UserID, "")
				} else {
					_ = e.store.SetCopyProtected(ctx, source.ID, true)
				}
			}
			server := &Server{Store: wrapped, Now: time.Now}
			result, err := server.scanDocumentReferences(ctx, guard, e.source.ID)
			if err != nil {
				t.Fatal(err)
			}
			if policy == "revoke" && len(result.Incoming) != 0 {
				t.Fatalf("revoked source leaked: %+v", result)
			}
			if policy == "protect" && (len(result.Incoming) != 1 || result.Incoming[0].Contexts[0].Text != "") {
				t.Fatalf("protected excerpt leaked: %+v", result)
			}
		})
	}
}

func TestDocumentReferencesEndpointRequiresAccount(t *testing.T) {
	e := newCopyTestEnv(t)
	request := func(header string) int {
		req, _ := http.NewRequest("GET", e.url()+"/references", nil)
		if header != "" {
			req.Header.Set("X-Jiange-User-Id", header)
		}
		r, err := e.owner.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		return r.StatusCode
	}
	if got := request(""); got != 400 {
		t.Fatalf("missing: %d", got)
	}
	if got := request(strconv.FormatInt(e.guestUser.ID, 10)); got != 401 {
		t.Fatalf("wrong: %d", got)
	}
	if got := request(strconv.FormatInt(e.ownerUser.ID, 10)); got != 200 {
		t.Fatalf("owner: %d", got)
	}
}

func TestDocumentReferencesResolveCurrentShareTokens(t *testing.T) {
	e := newCopyTestEnv(t)
	ctx := context.Background()
	source, err := e.store.CreateDoc(ctx, e.ownerSpace.ID, e.ownerUser.ID, nil, "来源", syncsrv.InitialOps("来源"))
	if err != nil {
		t.Fatal(err)
	}
	if err = e.store.SetLink(ctx, e.source.ID, store.Link{Role: "view", Token: "ref-token"}); err != nil {
		t.Fatal(err)
	}
	appendReference(t, e.store, source.ID, "#/s/ref-token", "登录链接")
	appendReference(t, e.store, source.ID, "#/p/ref-token", "失效的公开链接")
	guard := store.RestoreGuard{UserID: e.ownerUser.ID, SessionHash: []byte("references-owner")}
	if err = e.store.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: e.store, Now: time.Now}
	result, err := server.scanDocumentReferences(ctx, guard, e.source.ID)
	if err != nil || len(result.Incoming) != 1 || len(result.Incoming[0].Contexts) != 1 || result.Incoming[0].Contexts[0].Text != "登录链接" {
		t.Fatalf("signed-in token: %+v %v", result, err)
	}
	if err = e.store.SetLink(ctx, e.source.ID, store.Link{Role: "none"}); err != nil {
		t.Fatal(err)
	}
	result, err = server.scanDocumentReferences(ctx, guard, e.source.ID)
	if err != nil || len(result.Incoming) != 0 {
		t.Fatalf("closed token: %+v %v", result, err)
	}
}

func TestDocumentReferencesShowEligibleUnjoinedShareLink(t *testing.T) {
	e := newCopyTestEnv(t)
	ctx := context.Background()
	source, err := e.store.CreateDoc(ctx, e.guestSpace.ID, e.guestUser.ID, nil, "来源", syncsrv.InitialOps("来源"))
	if err != nil {
		t.Fatal(err)
	}
	if err = e.store.SetLink(ctx, e.source.ID, store.Link{Role: "view", Token: "ref-shared"}); err != nil {
		t.Fatal(err)
	}
	appendReference(t, e.store, source.ID, "#/s/ref-shared", "引用")
	guard := store.RestoreGuard{UserID: e.guestUser.ID, SessionHash: []byte("references-unjoined")}
	if err = e.store.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: e.store, Now: time.Now}
	result, err := server.scanDocumentReferences(ctx, guard, source.ID)
	if err != nil || len(result.Outgoing) != 1 || result.Outgoing[0].ID != e.source.ID || result.Outgoing[0].Href != "#/s/ref-shared" {
		t.Fatalf("unjoined link: %+v %v", result, err)
	}
	if _, err = e.store.GetDoc(ctx, guard.UserID, e.source.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("scan joined target: %v", err)
	}
	if err = e.store.SetLink(ctx, e.source.ID, store.Link{Role: "none"}); err != nil {
		t.Fatal(err)
	}
	result, err = server.scanDocumentReferences(ctx, guard, source.ID)
	if err != nil || len(result.Outgoing) != 0 {
		t.Fatalf("closed link: %+v %v", result, err)
	}
}

func TestDocumentReferenceIDValidation(t *testing.T) {
	for _, c := range []struct {
		link string
		want int64
	}{{"#/doc/12", 12}, {"#/doc/12?block=1%3A2", 12}, {"#/doc/012", 0}, {"#/doc/12?block=bad", 0}, {"#/doc/12?x=1", 0}, {"https://example.test/#/doc/12", 0}, {"#/doc/9007199254740992", 0}} {
		if got := documentReferenceID(c.link); got != c.want {
			t.Errorf("%q: %d", c.link, got)
		}
	}
}

func TestDocumentReferencesReportScanLimitInsteadOfPartialResults(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	user, ws, err := st.CreateUser(ctx, "reference-limit@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guard := store.RestoreGuard{UserID: user.ID, SessionHash: []byte("reference-limit-session")}
	if err = st.CreateSession(ctx, guard.SessionHash, user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var target int64
	for i := 0; i < 201; i++ {
		doc, e := st.CreateDoc(ctx, ws.ID, user.ID, nil, fmt.Sprintf("文档 %d", i), syncsrv.InitialOps("文档"))
		if e != nil {
			t.Fatal(e)
		}
		if i == 0 {
			target = doc.ID
		}
	}
	server := &Server{Store: st, Now: time.Now}
	if _, err = server.scanDocumentReferences(ctx, guard, target); !errors.Is(err, errReferenceIncomplete) {
		t.Fatalf("expected incomplete error, got %v", err)
	}
}

func TestDocumentReferencesPostgresAccessAndRevocation(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	st, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err = migrate.Up(ctx, st.Pool); err != nil {
		t.Fatal(err)
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 10)
	owner, ws, err := st.CreateUser(ctx, "ref-owner-"+suffix+"@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "ref-guest-"+suffix+"@test.dev", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	target, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "目标", syncsrv.InitialOps("目标"))
	if err != nil {
		t.Fatal(err)
	}
	source, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "来源", syncsrv.InitialOps("来源"))
	if err != nil {
		t.Fatal(err)
	}
	appendReference(t, st, source.ID, fmt.Sprintf("#/doc/%d", target.ID), "参考目标")
	for _, id := range []int64{target.ID, source.ID} {
		if err = st.SetShare(ctx, id, guest.ID, store.RoleView); err != nil {
			t.Fatal(err)
		}
	}
	guard := store.RestoreGuard{UserID: guest.ID, SessionHash: []byte("reference-pg-" + suffix)}
	if err = st.CreateSession(ctx, guard.SessionHash, guest.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: st, Now: time.Now}
	result, err := server.scanDocumentReferences(ctx, guard, target.ID)
	if err != nil || len(result.Incoming) != 1 || result.Incoming[0].ID != source.ID {
		t.Fatalf("visible: %+v %v", result, err)
	}
	if err = st.SetShare(ctx, source.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	result, err = server.scanDocumentReferences(ctx, guard, target.ID)
	if err != nil || len(result.Incoming) != 0 {
		t.Fatalf("revoked: %+v %v", result, err)
	}
}
