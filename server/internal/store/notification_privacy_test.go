package store_test

import (
	"context"
	"os"
	"testing"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseNotificationPrivacy(t *testing.T, st store.Store) {
	t.Helper()
	ctx := context.Background()
	parent, child, manager, guest, _ := guardedSharingFixture(t, st)
	other, err := st.CreateDoc(ctx, parent.WorkspaceID, parent.CreatorID, nil, "Visible", nil)
	if err != nil {
		t.Fatal(err)
	}
	comment, err := st.AddComment(ctx, store.Comment{DocID: child.ID, UserID: manager.ID, Body: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	item := store.Notification{UserID: guest.ID, DocID: child.ID, ActorID: manager.ID, CommentID: &comment.ID, Kind: "mention", Preview: "secret"}
	// Unknown or unauthorized recipients cannot acquire a notification simply
	// because a commenter mentioned their user ID.
	if err := st.AddNotifications(ctx, []store.Notification{item, {UserID: 999999, DocID: child.ID, ActorID: manager.ID, CommentID: &comment.ID, Kind: "mention"}}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetShare(ctx, child.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	got, err := st.Notifications(ctx, guest.ID, 100)
	if err != nil || len(got) != 0 {
		t.Fatalf("unauthorized mention persisted: %+v %v", got, err)
	}
	if err := st.SetShare(ctx, other.ID, guest.ID, store.RoleView); err != nil {
		t.Fatal(err)
	}
	otherComment, err := st.AddComment(ctx, store.Comment{DocID: other.ID, UserID: manager.ID, Body: "visible"})
	if err != nil {
		t.Fatal(err)
	}
	visible := store.Notification{UserID: guest.ID, DocID: other.ID, ActorID: manager.ID, CommentID: &otherComment.ID, Kind: "mention", Preview: "visible"}
	// A comment ID from a different document must not cross the boundary.
	wrong := visible
	wrong.CommentID = &comment.ID
	if err := st.AddNotifications(ctx, []store.Notification{visible, wrong}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 55; i++ {
		if err := st.AddNotifications(ctx, []store.Notification{item}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SetShare(ctx, child.ID, guest.ID, ""); err != nil {
		t.Fatal(err)
	}
	got, err = st.Notifications(ctx, guest.ID, 1)
	if err != nil || len(got) != 1 || got[0].DocID != other.ID || got[0].Preview != "visible" {
		t.Fatalf("filter must occur before limit: %+v %v", got, err)
	}
	unread, err := st.UnreadCount(ctx, guest.ID)
	if err != nil || unread != 1 {
		t.Fatalf("revoked unread count: %d %v", unread, err)
	}
	otherComment.Body = "edited"
	if _, err := st.UpdateComment(ctx, otherComment); err != nil {
		t.Fatal(err)
	}
	got, err = st.Notifications(ctx, guest.ID, 10)
	if err != nil || len(got) != 1 || got[0].Preview != "edited" {
		t.Fatalf("obsolete preview: %+v %v", got, err)
	}
	if err := st.DeleteComment(ctx, other.ID, otherComment.ID); err != nil {
		t.Fatal(err)
	}
	got, err = st.Notifications(ctx, guest.ID, 10)
	if err != nil || len(got) != 0 {
		t.Fatalf("deleted comment leaked: %+v %v", got, err)
	}
	unread, err = st.UnreadCount(ctx, guest.ID)
	if err != nil || unread != 0 {
		t.Fatalf("deleted comment unread: %d %v", unread, err)
	}
	newComment, err := st.AddComment(ctx, store.Comment{DocID: other.ID, UserID: manager.ID, Body: "new comment"})
	if err != nil || newComment.ID == otherComment.ID {
		t.Fatalf("comment ID reused after deletion: %+v %v", newComment, err)
	}
	got, err = st.Notifications(ctx, guest.ID, 10)
	if err != nil || len(got) != 0 {
		t.Fatalf("deleted comment notification resurfaced: %+v %v", got, err)
	}
}

func TestMemoryNotificationPrivacy(t *testing.T) { exerciseNotificationPrivacy(t, store.NewMemory()) }

func TestMemoryDeletedBaseCommentNotificationDoesNotResurface(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	parent, _, manager, guest, _ := guardedSharingFixture(t, st)
	base, err := st.CreateBase(ctx, parent.WorkspaceID, parent.CreatorID, nil, "Base")
	if err != nil {
		t.Fatal(err)
	}
	comment, err := st.AddComment(ctx, store.Comment{DocID: base.ID, UserID: manager.ID, Body: "base comment"})
	if err != nil {
		t.Fatal(err)
	}
	item := store.Notification{UserID: guest.ID, DocID: base.ID, ActorID: manager.ID, CommentID: &comment.ID, Kind: "mention", Preview: "base comment"}
	if err := st.AddNotifications(ctx, []store.Notification{item}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteComment(ctx, base.ID, comment.ID); err != nil {
		t.Fatal(err)
	}
	items, err := st.Notifications(ctx, guest.ID, 10)
	if err != nil || len(items) != 0 {
		t.Fatalf("deleted base comment notification: %+v %v", items, err)
	}
	unread, err := st.UnreadCount(ctx, guest.ID)
	if err != nil || unread != 0 {
		t.Fatalf("deleted base comment unread: %d %v", unread, err)
	}
	// Other Base notifications continue to use their existing path.
	item.CommentID = nil
	item.Preview = "automation"
	if err := st.AddNotifications(ctx, []store.Notification{item}); err != nil {
		t.Fatal(err)
	}
	items, err = st.Notifications(ctx, guest.ID, 10)
	if err != nil || len(items) != 1 || items[0].Preview != "automation" {
		t.Fatalf("base notification changed: %+v %v", items, err)
	}
}

func TestPostgresNotificationPrivacy(t *testing.T) {
	url := os.Getenv("JIANGE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("JIANGE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pg, err := store.NewPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err := pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseNotificationPrivacy(t, pg)
}
