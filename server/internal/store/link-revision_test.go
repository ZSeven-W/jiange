package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/store"
)

type revisionLinks interface {
	ChangeLinkRoleAtRevision(context.Context, store.RestoreGuard, int64, string, string, int64) (store.Link, error)
}

func checkLinkRevision(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	owner, ws, err := st.CreateUser(ctx, "link-revision-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	manager, _, err := st.CreateUser(ctx, "link-revision-manager@test.dev", "Manager", "hash")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := st.CreateUser(ctx, "link-revision-guest@test.dev", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDoc(ctx, ws.ID, owner.ID, nil, "Doc", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, doc.ID, manager.ID, store.RoleManage); err != nil {
		t.Fatal(err)
	}
	guards := []store.RestoreGuard{{UserID: owner.ID, SessionHash: []byte("link-revision-owner")}, {UserID: manager.ID, SessionHash: []byte("link-revision-manager")}, {UserID: guest.ID, SessionHash: []byte("link-revision-guest")}}
	for _, g := range guards {
		if err = st.CreateSession(ctx, g.SessionHash, g.UserID, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	r := st.(revisionLinks)
	initial, err := st.GetLink(ctx, doc.ID)
	if err != nil || initial.Role != "none" || initial.Revision != 0 {
		t.Fatalf("initial: %+v %v", initial, err)
	}
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = r.ChangeLinkRoleAtRevision(ctx, guards[i], doc.ID, []string{"view", "edit"}[i], []string{"token-a", "token-b"}[i], 0)
		}(i)
	}
	wg.Wait()
	if !((errs[0] == nil && errors.Is(errs[1], store.ErrConflict)) || (errs[1] == nil && errors.Is(errs[0], store.ErrConflict))) {
		t.Fatalf("concurrent updates: %v", errs)
	}
	current, err := st.GetLink(ctx, doc.ID)
	if err != nil || current.Revision != 1 || current.Token == "" {
		t.Fatalf("winner: %+v %v", current, err)
	}
	if _, err = r.ChangeLinkRoleAtRevision(ctx, guards[2], doc.ID, "none", "", current.Revision); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("guest update: %v", err)
	}
	closed, err := r.ChangeLinkRoleAtRevision(ctx, guards[0], doc.ID, "none", "", current.Revision)
	if err != nil || closed.Revision != 2 || closed.Token != "" {
		t.Fatalf("close: %+v %v", closed, err)
	}
	opened, err := st.ChangeLinkRoleGuarded(ctx, guards[0], doc.ID, "view", "legacy-reopen")
	if err != nil || opened.Revision != 3 {
		t.Fatalf("legacy update: %+v %v", opened, err)
	}
	if _, err = r.ChangeLinkRoleAtRevision(ctx, guards[1], doc.ID, "edit", "stale", current.Revision); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale setting overwrote later changes: %v", err)
	}
	actual, err := st.GetLink(ctx, doc.ID)
	if err != nil || actual.Role != "view" || actual.Token != "legacy-reopen" || actual.Revision != 3 {
		t.Fatalf("stale write changed link: %+v %v", actual, err)
	}
	for _, role := range []string{"edit", "view"} {
		if _, err = st.ChangeLinkRoleGuarded(ctx, guards[0], doc.ID, role, "ignored"); err != nil {
			t.Fatal(err)
		}
	}
	actual, err = st.GetLink(ctx, doc.ID)
	if err != nil || actual.Revision != 5 || actual.Role != "view" || actual.Token != "legacy-reopen" {
		t.Fatalf("same-token ABA: %+v %v", actual, err)
	}
	if _, err = r.ChangeLinkRoleAtRevision(ctx, guards[1], doc.ID, "edit", "stale", 3); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("same-token ABA was not fenced: %v", err)
	}
	if err = st.SetLink(ctx, doc.ID, store.Link{Role: "view", Token: "rotated"}); err != nil {
		t.Fatal(err)
	}
	actual, _ = st.GetLink(ctx, doc.ID)
	if actual.Revision != 6 {
		t.Fatalf("legacy token rotation not fenced: %+v", actual)
	}
	if err = st.SetLink(ctx, doc.ID, store.Link{Role: "view", Token: "rotated"}); err != nil {
		t.Fatal(err)
	}
	actual, _ = st.GetLink(ctx, doc.ID)
	if actual.Revision != 6 {
		t.Fatalf("no-op changed revision: %+v", actual)
	}
	if err = st.SetShare(ctx, doc.ID, manager.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = r.ChangeLinkRoleAtRevision(ctx, guards[1], doc.ID, "none", "", 6); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("revoked manager: %v", err)
	}
}

func TestMemoryLinkRevision(t *testing.T)   { checkLinkRevision(t, store.NewMemory()) }
func TestPostgresLinkRevision(t *testing.T) { checkLinkRevision(t, atomicPostgres(t)) }
