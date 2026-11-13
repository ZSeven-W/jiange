package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func checkSlidesCopyStore(t *testing.T, st Store) {
	t.Helper()
	ctx := context.Background()
	owner, wsOwner, err := st.CreateUser(ctx, "slide-copy-owner@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	_, wsGuest, err := st.CreateUser(ctx, "slide-copy-guest@test.dev", "Guest", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := RestoreGuard{UserID: owner.ID, SessionHash: []byte("slide-copy-owner")}
	if err = st.CreateSession(ctx, g.SessionHash, owner.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	guest := RestoreGuard{UserID: wsGuest.OwnerID, SessionHash: []byte("slide-copy-guest")}
	if err = st.CreateSession(ctx, guest.SessionHash, wsGuest.OwnerID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deck, err := st.CreateDriveNode(ctx, g, wsOwner.ID, nil, "slides", "季度汇报", true)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateDriveNode(ctx, g, wsOwner.ID, nil, "doc", "普通文档", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = st.CopySlidesDeck(ctx, SlidesDeckCopy{SourceID: doc.ID, UserID: owner.ID, WorkspaceID: wsOwner.ID, Title: "x", Guard: &g}); !errors.Is(err, ErrConflict) {
		t.Fatalf("doc via deck copy: %v", err)
	}
	if _, err = st.CreateSlidesPage(ctx, g, deck.ID, "议程"); err != nil {
		t.Fatal(err)
	}
	image, err := st.CreateSlidesFile(ctx, g, deck.ID, FileMeta{Name: "a.png", Mime: "image/png", Size: 3, ObjectKey: "slides/copy-test/a"})
	if err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(pages) != 2 {
		t.Fatalf("pages: %v %v", pages, err)
	}
	cover := pages[0]
	coverShapes := json.RawMessage(fmt.Sprintf(`[{"id":"img","kind":"image","x":10,"y":10,"width":30,"height":30,"color":"#ffffff","fileId":%d}]`, image.ID))
	if _, err = st.UpdateSlidesPage(ctx, g, cover.ID, "封面", "正文", "#ff8800", strPtr("备注"), &coverShapes, cover.Revision); err != nil {
		t.Fatal(err)
	}

	// 未共享的访客读不到源：副本不存在。
	if _, _, err = st.CopySlidesDeck(ctx, SlidesDeckCopy{SourceID: deck.ID, UserID: wsGuest.OwnerID, WorkspaceID: wsGuest.ID, Title: "x", Guard: &guest}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("guest copy without share: %v", err)
	}
	if err = st.SetShare(ctx, deck.ID, wsGuest.OwnerID, RoleView); err != nil {
		t.Fatal(err)
	}
	// A workspace member with only read access to a private folder cannot
	// publish copies into it, even if that member owns the workspace.
	if err = st.AddWorkspaceMember(ctx, wsGuest.ID, owner.ID); err != nil {
		t.Fatal(err)
	}
	folder, err := st.CreateDriveFolder(ctx, g, wsGuest.ID, nil, "Private folder", true)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.SetShare(ctx, folder.ID, wsGuest.OwnerID, RoleView); err != nil {
		t.Fatal(err)
	}
	if _, _, err = st.CopySlidesDeck(ctx, SlidesDeckCopy{SourceID: deck.ID, UserID: wsGuest.OwnerID, WorkspaceID: wsGuest.ID, ParentID: &folder.ID, Title: "x", Guard: &guest}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("copy into read-only folder: %v", err)
	}
	// 有阅读权，但目标空间不是访客的成员空间。
	if _, _, err = st.CopySlidesDeck(ctx, SlidesDeckCopy{SourceID: deck.ID, UserID: wsGuest.OwnerID, WorkspaceID: wsOwner.ID, Title: "x", Guard: &guest}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("guest copy into foreign workspace: %v", err)
	}
	// 复制保护打开后，阅读者不能创建副本。
	if err = st.SetCopyProtected(ctx, deck.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err = st.CopySlidesDeck(ctx, SlidesDeckCopy{SourceID: deck.ID, UserID: wsGuest.OwnerID, WorkspaceID: wsGuest.ID, Title: "x", Guard: &guest}); !errors.Is(err, ErrCopyProtected) {
		t.Fatalf("protected copy: %v", err)
	}
	if err = st.SetCopyProtected(ctx, deck.ID, false); err != nil {
		t.Fatal(err)
	}

	if _, _, err = st.CopySlidesDeck(ctx, SlidesDeckCopy{SourceID: deck.ID, UserID: owner.ID, WorkspaceID: wsOwner.ID, Title: "not verified", Guard: &g, VerifiedImageIDs: []int64{}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("unverified source image accepted: %v", err)
	}
	meta, copied, err := st.CopySlidesDeck(ctx, SlidesDeckCopy{SourceID: deck.ID, UserID: owner.ID, WorkspaceID: wsOwner.ID, Title: "季度汇报 副本", Guard: &g, VerifiedImageIDs: []int64{image.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if meta.Kind != "slides" || meta.ID == deck.ID || meta.Title != "季度汇报 副本" {
		t.Fatalf("copy meta: %+v", meta)
	}
	if len(copied) != 2 || copied[0].Title != "封面" || copied[1].Title != "议程" || copied[0].Pos != pages[0].Pos {
		t.Fatalf("copied pages: %+v", copied)
	}
	if copied[0].Body != "正文" || copied[0].Background != "#ff8800" || copied[0].Notes != "备注" || copied[0].Revision != 1 {
		t.Fatalf("copied page content: %+v", copied[0])
	}
	var shapes []struct {
		Kind   string `json:"kind"`
		FileID int64  `json:"fileId"`
	}
	if err = json.Unmarshal(copied[0].Shapes, &shapes); err != nil || len(shapes) != 1 || shapes[0].FileID == image.ID {
		t.Fatalf("copied shapes not remapped: %s (%v)", copied[0].Shapes, err)
	}
	remapped := shapes[0].FileID
	clone, err := st.GetFile(ctx, remapped)
	if err != nil || clone.DocID != meta.ID || clone.ObjectKey != "slides/copy-test/a" || clone.Size != 3 {
		t.Fatalf("remapped attachment: %+v %v", clone, err)
	}
	if original, err := st.GetFile(ctx, image.ID); err != nil || original.DocID != deck.ID {
		t.Fatalf("source attachment changed: %+v %v", original, err)
	}
	// 副本页面不能引用源文稿的图片，可以引用自己的。
	mixed := json.RawMessage(fmt.Sprintf(`[{"id":"img","kind":"image","x":10,"y":10,"width":30,"height":30,"color":"#ffffff","fileId":%d}]`, image.ID))
	if _, err = st.UpdateSlidesPage(ctx, g, copied[0].ID, "", "", "", nil, &mixed, copied[0].Revision); !errors.Is(err, ErrConflict) {
		t.Fatalf("copy accepted source image: %v", err)
	}
	own := json.RawMessage(fmt.Sprintf(`[{"id":"img","kind":"image","x":10,"y":10,"width":30,"height":30,"color":"#ffffff","fileId":%d}]`, remapped))
	if _, err = st.UpdateSlidesPage(ctx, g, copied[0].ID, "封面改", "", "", nil, &own, copied[0].Revision); err != nil {
		t.Fatalf("copy edit own image: %v", err)
	}
	// 源文稿不受影响。
	source, err := st.ListSlidesPages(ctx, owner.ID, deck.ID)
	if err != nil || len(source) != 2 || source[0].Title != "封面" {
		t.Fatalf("source pages after copy: %v %v", source, err)
	}
	// 会话失效后拒绝复制。
	if err = st.DeleteSession(ctx, g.SessionHash); err != nil {
		t.Fatal(err)
	}
	if _, _, err = st.CopySlidesDeck(ctx, SlidesDeckCopy{SourceID: deck.ID, UserID: owner.ID, WorkspaceID: wsOwner.ID, Title: "x", Guard: &g}); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("revoked copy: %v", err)
	}
}

func strPtr(s string) *string { return &s }

func TestSlidesCopyPreservesExactJSONNumbers(t *testing.T) {
	input := json.RawMessage(`[{"kind":"image","fileId":9007199254740993,"custom":9007199254740995},{"kind":"text","text":"x","extra":{"precise":9007199254740997}}]`)
	out, err := remapSlideShapes(input, map[int64]int64{9007199254740993: 11})
	if err != nil {
		t.Fatal(err)
	}
	var items []map[string]json.RawMessage
	if err = json.Unmarshal(out, &items); err != nil {
		t.Fatal(err)
	}
	if string(items[0]["fileId"]) != "11" || string(items[0]["custom"]) != "9007199254740995" || string(items[1]["extra"]) != `{"precise":9007199254740997}` {
		t.Fatalf("copy lost number precision: %s", out)
	}
}

func TestMemorySlidesCopyFailureDoesNotPublishPartialDeck(t *testing.T) {
	ctx := context.Background()
	st := NewMemory()
	u, ws, err := st.CreateUser(ctx, "bad-slide-copy@test.dev", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	g := RestoreGuard{UserID: u.ID, SessionHash: []byte("bad-copy-session")}
	if err = st.CreateSession(ctx, g.SessionHash, u.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	d, err := st.CreateDriveNode(ctx, g, ws.ID, nil, "slides", "source", true)
	if err != nil {
		t.Fatal(err)
	}
	f, err := st.CreateSlidesFile(ctx, g, d.ID, FileMeta{Name: "x.png", Mime: "image/png", ObjectKey: "x"})
	if err != nil {
		t.Fatal(err)
	}
	st.mu.Lock()
	st.slides[0].Shapes = json.RawMessage(fmt.Sprintf(`[{"kind":"image","fileId":%d},{"unexpected":true}]`, f.ID))
	beforeDocs, beforeFiles, beforePages := len(st.d.docs), len(st.sh.files), len(st.slides)
	st.mu.Unlock()
	if _, _, err = st.CopySlidesDeck(ctx, SlidesDeckCopy{SourceID: d.ID, UserID: u.ID, WorkspaceID: ws.ID, Title: "copy", Guard: &g, VerifiedImageIDs: []int64{f.ID}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("invalid source: %v", err)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.d.docs) != beforeDocs || len(st.sh.files) != beforeFiles || len(st.slides) != beforePages {
		t.Fatal("failed copy published partial state")
	}
}

func TestMemorySlidesCopyStore(t *testing.T) { checkSlidesCopyStore(t, NewMemory()) }

func TestPostgresSlidesCopyStore(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("jiange_slide_copy_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
		admin.Close()
	}()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err = migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	checkSlidesCopyStore(t, &Postgres{Pool: pool})
}
