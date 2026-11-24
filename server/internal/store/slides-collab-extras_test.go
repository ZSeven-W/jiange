package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func exerciseSlidesExtrasStore(t *testing.T, st store.Store, extras store.SlidesExtrasStore, metaStore store.SlidesMetaStore) {
	t.Helper()
	ctx := context.Background()

	owner, ws, err := st.CreateUser(ctx, "slides-extras-owner@example.test", "DeckOwner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := st.CreateUser(ctx, "slides-extras-editor@example.test", "DeckEditor", "hash")
	if err != nil {
		t.Fatal(err)
	}
	viewer1, _, err := st.CreateUser(ctx, "slides-extras-viewer1@example.test", "DeckViewer1", "hash")
	if err != nil {
		t.Fatal(err)
	}
	viewer2, _, err := st.CreateUser(ctx, "slides-extras-viewer2@example.test", "DeckViewer2", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, _, err := st.CreateUser(ctx, "slides-extras-outsider@example.test", "DeckOutsider", "hash")
	if err != nil {
		t.Fatal(err)
	}

	ownerG := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("se-owner-sess")}
	editorG := store.RestoreGuard{UserID: editor.ID, SessionHash: []byte("se-editor-sess")}
	viewer1G := store.RestoreGuard{UserID: viewer1.ID, SessionHash: []byte("se-viewer1-sess")}
	viewer2G := store.RestoreGuard{UserID: viewer2.ID, SessionHash: []byte("se-viewer2-sess")}
	outsiderG := store.RestoreGuard{UserID: outsider.ID, SessionHash: []byte("se-outsider-sess")}

	for _, s := range []struct {
		id   int64
		hash []byte
	}{
		{owner.ID, ownerG.SessionHash},
		{editor.ID, editorG.SessionHash},
		{viewer1.ID, viewer1G.SessionHash},
		{viewer2.ID, viewer2G.SessionHash},
		{outsider.ID, outsiderG.SessionHash},
	} {
		if err := st.CreateSession(ctx, s.hash, s.id, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}

	deck, err := st.CreateDriveNode(ctx, ownerG, ws.ID, nil, "slides", "产品规划 Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	otherDeck, err := st.CreateDriveNode(ctx, ownerG, ws.ID, nil, "slides", "其他 Deck", true)
	if err != nil {
		t.Fatal(err)
	}
	docNode, err := st.CreateDriveNode(ctx, ownerG, ws.ID, nil, "doc", "普通文档", true)
	if err != nil {
		t.Fatal(err)
	}

	if err := st.SetShare(ctx, deck.ID, editor.ID, store.RoleEdit); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, deck.ID, viewer1.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, deck.ID, viewer2.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}

	initialPages, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(initialPages) != 1 {
		t.Fatalf("initial pages: %+v err=%v", initialPages, err)
	}
	otherPages, err := st.ListSlidesPages(ctx, owner.ID, otherDeck.ID)
	if err != nil || len(otherPages) != 1 {
		t.Fatalf("other deck pages: %+v err=%v", otherPages, err)
	}

	p1 := initialPages[0]
	p2, err := st.CreateSlidesPage(ctx, ownerG, deck.ID, "第二页")
	if err != nil {
		t.Fatal(err)
	}

	// --- Part 1: Slides Comments ---

	// Non-slides node & outsider access -> ErrNotFound.
	if _, err := extras.ListSlidesComments(ctx, ownerG, docNode.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("doc node comments expected ErrNotFound, got %v", err)
	}
	if _, err := extras.ListSlidesComments(ctx, outsiderG, deck.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("outsider ListSlidesComments expected ErrNotFound, got %v", err)
	}
	if _, err := extras.CreateSlidesCommentGuarded(ctx, outsiderG, deck.ID, p1.ID, "", "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("outsider CreateSlidesComment expected ErrNotFound, got %v", err)
	}

	// Empty list returns non-nil slice.
	emptyComments, err := extras.ListSlidesComments(ctx, viewer1G, deck.ID)
	if err != nil || emptyComments == nil || len(emptyComments) != 0 {
		t.Fatalf("empty comments = %#v err=%v", emptyComments, err)
	}

	// Validation: empty body, oversized body (>2000 runes), oversized shapeID, foreign pageID.
	if _, err := extras.CreateSlidesCommentGuarded(ctx, viewer1G, deck.ID, p1.ID, "", "   "); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("empty body expected ErrConflict, got %v", err)
	}
	if _, err := extras.CreateSlidesCommentGuarded(ctx, viewer1G, deck.ID, p1.ID, "", strings.Repeat("评", 2001)); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("2001 rune body expected ErrConflict, got %v", err)
	}
	if _, err := extras.CreateSlidesCommentGuarded(ctx, viewer1G, deck.ID, p1.ID, strings.Repeat("s", 65), "ok"); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("oversized shapeID expected ErrConflict, got %v", err)
	}
	if _, err := extras.CreateSlidesCommentGuarded(ctx, viewer1G, deck.ID, otherPages[0].ID, "", "wrong deck page"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign pageID expected ErrNotFound, got %v", err)
	}
	if _, err := extras.CreateSlidesCommentGuarded(ctx, viewer1G, deck.ID, 999999, "", "missing page"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing pageID expected ErrNotFound, got %v", err)
	}

	// Viewer1 can create a shape-anchored comment (2000 runes max allowed).
	maxBody := strings.Repeat("赞", 2000)
	c1, err := extras.CreateSlidesCommentGuarded(ctx, viewer1G, deck.ID, p1.ID, "shape-hero", "  "+maxBody+"  ")
	if err != nil {
		t.Fatalf("viewer1 create comment: %v", err)
	}
	if c1.ID <= 0 || c1.SlidesID != deck.ID || c1.PageID != p1.ID || c1.ShapeID != "shape-hero" || c1.AuthorID != viewer1.ID || c1.AuthorName != "DeckViewer1" || c1.Body != maxBody || c1.Resolved {
		t.Fatalf("unexpected c1: %+v", c1)
	}

	// Editor creates a page-level comment on page 2.
	c2, err := extras.CreateSlidesCommentGuarded(ctx, editorG, deck.ID, p2.ID, "", "请补充数据来源")
	if err != nil {
		t.Fatalf("editor create comment: %v", err)
	}
	if c2.ShapeID != "" || c2.AuthorID != editor.ID || c2.AuthorName != "DeckEditor" {
		t.Fatalf("unexpected c2: %+v", c2)
	}

	// Permission matrix on UpdateSlidesCommentGuarded:
	// - Another viewer (viewer2) cannot edit body or resolve viewer1's comment.
	newBody := "篡改内容"
	resolvedTrue := true
	resolvedFalse := false
	if _, err := extras.UpdateSlidesCommentGuarded(ctx, viewer2G, deck.ID, c1.ID, &newBody, nil); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer2 edit body expected ErrForbidden, got %v", err)
	}
	if _, err := extras.UpdateSlidesCommentGuarded(ctx, viewer2G, deck.ID, c1.ID, nil, &resolvedTrue); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer2 resolve expected ErrForbidden, got %v", err)
	}
	// - Editor cannot edit viewer1's body, but CAN resolve viewer1's comment.
	if _, err := extras.UpdateSlidesCommentGuarded(ctx, editorG, deck.ID, c1.ID, &newBody, nil); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("editor edit other body expected ErrForbidden, got %v", err)
	}
	c1Resolved, err := extras.UpdateSlidesCommentGuarded(ctx, editorG, deck.ID, c1.ID, nil, &resolvedTrue)
	if err != nil || !c1Resolved.Resolved {
		t.Fatalf("editor resolve c1: %+v err=%v", c1Resolved, err)
	}
	// - Author (viewer1) can edit own body and reopen own comment.
	authorBody := "已修改的批注"
	c1Edited, err := extras.UpdateSlidesCommentGuarded(ctx, viewer1G, deck.ID, c1.ID, &authorBody, &resolvedFalse)
	if err != nil || c1Edited.Body != authorBody || c1Edited.Resolved {
		t.Fatalf("author edit+reopen c1: %+v err=%v", c1Edited, err)
	}
	// - Manager (owner) can edit another user's body and resolve.
	mgrBody := "管理员修订"
	c1Mgr, err := extras.UpdateSlidesCommentGuarded(ctx, ownerG, deck.ID, c1.ID, &mgrBody, &resolvedTrue)
	if err != nil || c1Mgr.Body != mgrBody || !c1Mgr.Resolved {
		t.Fatalf("manager edit c1: %+v err=%v", c1Mgr, err)
	}
	// - Empty patch rejected.
	if _, err := extras.UpdateSlidesCommentGuarded(ctx, ownerG, deck.ID, c1.ID, nil, nil); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("empty patch expected ErrConflict, got %v", err)
	}

	// Delete permission matrix:
	// - viewer2 and editor cannot delete viewer1's comment.
	if err := extras.DeleteSlidesCommentGuarded(ctx, viewer2G, deck.ID, c1.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer2 delete c1 expected ErrForbidden, got %v", err)
	}
	if err := extras.DeleteSlidesCommentGuarded(ctx, editorG, deck.ID, c1.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("editor delete c1 expected ErrForbidden, got %v", err)
	}
	// - Author can delete own comment (c2 by editor).
	if err := extras.DeleteSlidesCommentGuarded(ctx, editorG, deck.ID, c2.ID); err != nil {
		t.Fatalf("author delete c2: %v", err)
	}
	// - Manager can delete another user's comment (c1 by viewer1).
	if err := extras.DeleteSlidesCommentGuarded(ctx, ownerG, deck.ID, c1.ID); err != nil {
		t.Fatalf("manager delete c1: %v", err)
	}
	if err := extras.DeleteSlidesCommentGuarded(ctx, ownerG, deck.ID, c1.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleting missing comment expected ErrNotFound, got %v", err)
	}

	// --- Part 2: Slides Versions & Full-Fidelity Restore ---

	// Enrich p1 and p2 with content, shapes, layout, notes, hidden, meta, and custom sort order.
	notes1 := "封面演讲备注"
	shapes1 := json.RawMessage(`[{"id":"rect-1","kind":"rectangle","x":10,"y":15,"width":30,"height":20,"color":"#3370ff"}]`)
	p1, err = st.UpdateSlidesPageV3(ctx, ownerG, deck.ID, p1.ID, "封面标题", "第一页正文", "#0f1f3d", "title", &notes1, &shapes1, p1.Revision)
	if err != nil {
		t.Fatalf("update p1: %v", err)
	}
	meta1Raw := json.RawMessage(`{"titleStyle":{"fontSize":48,"bold":true,"color":"#ffffff","align":"center"},"bodyStyle":{"fontSize":20,"italic":true,"color":"#cbd5e1"},"transition":"fade","shapeGroups":{"grp-1":["rect-1","txt-2"]}}`)
	p1, err = metaStore.UpdateSlidesPageMeta(ctx, ownerG, deck.ID, p1.ID, meta1Raw)
	if err != nil {
		t.Fatalf("update p1 meta: %v", err)
	}

	notes2 := "隐藏页备注"
	shapes2 := json.RawMessage(`[{"id":"txt-1","kind":"text","x":12,"y":20,"width":40,"height":15,"color":"#1f2329","text":"补充说明"}]`)
	p2, err = st.UpdateSlidesPageV3(ctx, ownerG, deck.ID, p2.ID, "隐藏页标题", "第二页正文", "#f7f8fa", "blank", &notes2, &shapes2, p2.Revision)
	if err != nil {
		t.Fatalf("update p2: %v", err)
	}
	p2, err = st.SetSlidesPageHidden(ctx, ownerG, deck.ID, p2.ID, p2.Revision, true)
	if err != nil {
		t.Fatalf("hide p2: %v", err)
	}
	// Move p2 BEFORE p1 (pos = 0.5) so sort order is [p2, p1].
	if err := st.MoveSlidesPage(ctx, ownerG, p2.ID, 0.5); err != nil {
		t.Fatalf("move p2: %v", err)
	}

	// Permission checks on versions.
	if _, err := extras.ListSlidesVersions(ctx, outsiderG, deck.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("outsider ListSlidesVersions expected ErrNotFound, got %v", err)
	}
	if _, err := extras.CreateSlidesVersionGuarded(ctx, viewer1G, deck.ID, "viewer-nope", false); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer CreateSlidesVersion expected ErrForbidden, got %v", err)
	}
	if _, err := extras.CreateSlidesVersionGuarded(ctx, editorG, deck.ID, strings.Repeat("名", 121), false); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("oversized label expected ErrConflict, got %v", err)
	}

	// Editor creates named version v1.
	v1, err := extras.CreateSlidesVersionGuarded(ctx, editorG, deck.ID, "Q4 评审基线", false)
	if err != nil {
		t.Fatalf("create v1: %v", err)
	}
	if v1.ID <= 0 || v1.SlidesID != deck.ID || v1.Label != "Q4 评审基线" || v1.AutoSaved || v1.CreatedBy != editor.ID || v1.ActorName != "DeckEditor" || v1.PageCount != 2 {
		t.Fatalf("unexpected v1: %+v", v1)
	}

	// Viewer can list versions, cannot restore.
	listedV, err := extras.ListSlidesVersions(ctx, viewer1G, deck.ID)
	if err != nil || len(listedV) != 1 || listedV[0].ID != v1.ID {
		t.Fatalf("viewer list versions = %+v err=%v", listedV, err)
	}
	if _, err := extras.RestoreSlidesVersionGuarded(ctx, viewer1G, deck.ID, v1.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("viewer restore expected ErrForbidden, got %v", err)
	}

	// Mutate live deck drastically: delete p1, edit p2, add a 3rd page.
	if err := st.DeleteSlidesPage(ctx, ownerG, p1.ID); err != nil {
		t.Fatalf("delete p1: %v", err)
	}
	if _, err := st.UpdateSlidesPageV3(ctx, ownerG, deck.ID, p2.ID, "被改坏的标题", "被改坏的正文", "#000000", "", nil, nil, p2.Revision); err != nil {
		t.Fatalf("mutate p2: %v", err)
	}
	if _, err := st.CreateSlidesPage(ctx, ownerG, deck.ID, "临时新增页A"); err != nil {
		t.Fatalf("add temp page A: %v", err)
	}
	if _, err := st.CreateSlidesPage(ctx, ownerG, deck.ID, "临时新增页B"); err != nil {
		t.Fatalf("add temp page B: %v", err)
	}

	// Non-existent version and cross-deck version restore -> ErrNotFound.
	if _, err := extras.RestoreSlidesVersionGuarded(ctx, ownerG, deck.ID, 999999); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing version restore expected ErrNotFound, got %v", err)
	}
	if _, err := extras.RestoreSlidesVersionGuarded(ctx, ownerG, otherDeck.ID, v1.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-deck version restore expected ErrNotFound, got %v", err)
	}

	// Restore v1 -> auto-saves pre-restore backup (3 pages) and restores [p2, p1] with full fidelity!
	restored, err := extras.RestoreSlidesVersionGuarded(ctx, ownerG, deck.ID, v1.ID)
	if err != nil {
		t.Fatalf("restore v1: %v", err)
	}
	if len(restored) != 2 {
		t.Fatalf("restored page count = %d, want 2", len(restored))
	}

	// First page in restored deck must be old p2 (was moved to pos 0.5 before v1).
	rp0, rp1 := restored[0], restored[1]
	if rp0.Title != "隐藏页标题" || rp0.Body != "第二页正文" || rp0.Notes != notes2 || rp0.Background != "#f7f8fa" || rp0.Layout != "blank" || !rp0.Hidden || rp0.Pos >= rp1.Pos {
		t.Fatalf("restored page 0 mismatch: %+v", rp0)
	}
	if !strings.Contains(string(rp0.Shapes), `"txt-1"`) {
		t.Fatalf("restored page 0 lost shapes: %s", rp0.Shapes)
	}

	// Second page in restored deck must be old p1 with full meta preserved.
	if rp1.Title != "封面标题" || rp1.Body != "第一页正文" || rp1.Notes != notes1 || rp1.Background != "#0f1f3d" || rp1.Layout != "title" || rp1.Hidden {
		t.Fatalf("restored page 1 mismatch: %+v", rp1)
	}
	if !strings.Contains(string(rp1.Shapes), `"rect-1"`) {
		t.Fatalf("restored page 1 lost shapes: %s", rp1.Shapes)
	}
	var restoredMeta store.SlidePageMeta
	if err := json.Unmarshal(rp1.Meta, &restoredMeta); err != nil {
		t.Fatalf("restored page 1 meta unmarshal: %v (%s)", err, rp1.Meta)
	}
	if restoredMeta.TitleStyle == nil || *restoredMeta.TitleStyle.FontSize != 48 || !*restoredMeta.TitleStyle.Bold || *restoredMeta.TitleStyle.Color != "#ffffff" || *restoredMeta.TitleStyle.Align != "center" {
		t.Fatalf("restored page 1 titleStyle mismatch: %+v", restoredMeta.TitleStyle)
	}
	if restoredMeta.BodyStyle == nil || !*restoredMeta.BodyStyle.Italic || *restoredMeta.BodyStyle.Color != "#cbd5e1" {
		t.Fatalf("restored page 1 bodyStyle mismatch: %+v", restoredMeta.BodyStyle)
	}
	if restoredMeta.Transition == nil || *restoredMeta.Transition != "fade" || !reflect.DeepEqual(restoredMeta.ShapeGroups["grp-1"], []string{"rect-1", "txt-2"}) {
		t.Fatalf("restored page 1 transition/shapeGroups mismatch: %+v", restoredMeta)
	}

	// Live ListSlidesPages agrees with restored pages.
	livePages, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(livePages) != 2 || livePages[0].Title != "隐藏页标题" || livePages[1].Title != "封面标题" || len(livePages[1].Meta) == 0 {
		t.Fatalf("live pages after restore mismatch: %+v err=%v", livePages, err)
	}

	// Version list now has pre-restore backup first (3 pages), then v1 (2 pages).
	versionsAfter, err := extras.ListSlidesVersions(ctx, ownerG, deck.ID)
	if err != nil || len(versionsAfter) != 2 {
		t.Fatalf("versions after restore: %+v err=%v", versionsAfter, err)
	}
	if !versionsAfter[0].AutoSaved || versionsAfter[0].Label != "恢复前自动备份" || versionsAfter[0].PageCount != 3 || versionsAfter[0].ActorName != "DeckOwner" {
		t.Fatalf("expected auto pre-restore backup first, got %+v", versionsAfter[0])
	}
	if versionsAfter[1].ID != v1.ID {
		t.Fatalf("expected v1 second, got %+v", versionsAfter[1])
	}

	// Empty label defaults cleanly for manual vs auto.
	vDefaultManual, err := extras.CreateSlidesVersionGuarded(ctx, ownerG, deck.ID, "  ", false)
	if err != nil || vDefaultManual.Label != "未命名版本" || vDefaultManual.AutoSaved {
		t.Fatalf("default manual version mismatch: %+v err=%v", vDefaultManual, err)
	}
	vDefaultAuto, err := extras.CreateSlidesVersionGuarded(ctx, ownerG, deck.ID, "", true)
	if err != nil || vDefaultAuto.Label != "自动备份" || !vDefaultAuto.AutoSaved {
		t.Fatalf("default auto version mismatch: %+v err=%v", vDefaultAuto, err)
	}

	// Version listing caps at 100 newest-first.
	for i := range 102 {
		if _, err := extras.CreateSlidesVersionGuarded(ctx, ownerG, otherDeck.ID, fmt.Sprintf("v-%03d", i), false); err != nil {
			t.Fatalf("create version %d: %v", i, err)
		}
	}
	capped, err := extras.ListSlidesVersions(ctx, ownerG, otherDeck.ID)
	if err != nil || len(capped) != 100 || capped[0].Label != "v-101" {
		t.Fatalf("capped versions len=%d first=%+v err=%v", len(capped), capped[0], err)
	}

	// Revoked session rejected across all operations.
	if err := st.DeleteSession(ctx, ownerG.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, err := extras.ListSlidesComments(ctx, ownerG, deck.ID); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked ListSlidesComments = %v", err)
	}
	if _, err := extras.ListSlidesVersions(ctx, ownerG, deck.ID); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked ListSlidesVersions = %v", err)
	}
	if _, err := extras.CreateSlidesVersionGuarded(ctx, ownerG, deck.ID, "fail", false); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("revoked CreateSlidesVersion = %v", err)
	}
}

func TestSlidesExtrasMemory(t *testing.T) {
	m := store.NewMemory()
	exerciseSlidesExtrasStore(t, m, m, m)
}

func TestSlidesExtrasPostgres(t *testing.T) {
	dsn := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("test_slides_extras_%d", time.Now().UnixNano())
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	pg := &store.Postgres{Pool: pool}
	exerciseSlidesExtrasStore(t, pg, pg, pg)
}
