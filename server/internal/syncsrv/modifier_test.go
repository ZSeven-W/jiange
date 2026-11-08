package syncsrv

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func checkSyncModifier(t *testing.T, st store.Store) {
	t.Helper()
	e := newEnv(t, st, 1000)
	doc := e.newDoc()
	owner, editor := e.client(0, doc), e.client(1, doc)
	ctx := context.Background()
	guard := store.RestoreGuard{UserID: e.users[0].ID, SessionHash: []byte("sync-modifier-session")}
	if err := st.CreateSession(ctx, guard.SessionHash, guard.UserID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	last := func() string {
		entries, err := st.ListDriveChildren(ctx, guard, e.ws.ID, nil, false)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if entry.ID == doc {
				return entry.LastModifierName
			}
		}
		t.Fatal("document missing")
		return ""
	}
	editor.edit(typeAt("editor", func(n int) int { return n }))
	converge(t, st, doc, owner, editor)
	if got := last(); got != e.users[1].Name {
		t.Fatalf("editor attribution = %q", got)
	}
	owner.edit(typeAt(" owner", func(n int) int { return n }))
	converge(t, st, doc, owner, editor)
	if got := last(); got != e.users[0].Name {
		t.Fatalf("owner attribution = %q", got)
	}
}

func TestMemorySyncModifier(t *testing.T) { checkSyncModifier(t, store.NewMemory()) }

func TestPostgresSyncModifier(t *testing.T) {
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
	if _, err = migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	checkSyncModifier(t, pg)
}
