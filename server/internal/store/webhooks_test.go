package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseWebhookStore(t *testing.T, st interface {
	store.Store
	store.WebhookStore
}) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	exp := now.Add(time.Hour)

	owner, ws, err := st.CreateUser(ctx, "wh-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	adminUser, _, err := st.CreateUser(ctx, "wh-admin@example.test", "Admin", "hash")
	if err != nil {
		t.Fatal(err)
	}
	memberUser, _, err := st.CreateUser(ctx, "wh-member@example.test", "Member", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, otherWS, err := st.CreateUser(ctx, "wh-outsider@example.test", "Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}

	makeGuard := func(u store.User, tag string) store.RestoreGuard {
		g := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("wh-sess-" + tag), Now: func() time.Time { return now }}
		if err := st.CreateSession(ctx, g.SessionHash, u.ID, exp); err != nil {
			t.Fatal(err)
		}
		return g
	}
	ownerGuard := makeGuard(owner, "owner")
	adminGuard := makeGuard(adminUser, "admin")
	memberGuard := makeGuard(memberUser, "member")
	outsiderGuard := makeGuard(outsider, "outsider")
	badSessGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("nonexistent"), Now: func() time.Time { return now }}

	if err := st.AddWorkspaceMember(ctx, ws.ID, adminUser.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, adminUser.Email, store.WorkspaceRoleAdmin); err != nil {
		t.Fatal(err)
	}
	if err := st.AddWorkspaceMember(ctx, ws.ID, memberUser.ID); err != nil {
		t.Fatal(err)
	}

	validInput := store.WorkspaceWebhookInput{
		Name:       "CI Notification Hook",
		URL:        "https://hooks.example.com/jiange",
		SecretEnc:  []byte("sealed-secret-ciphertext"),
		SecretHint: "abcd",
		Events:     []string{store.WebhookEventDocCreated, store.WebhookEventDocDeleted, " DOC.CREATED "},
		Enabled:    true,
	}

	// Access control checks.
	if _, err := st.ListWorkspaceWebhooks(ctx, badSessGuard, ws.ID); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("bad session ListWorkspaceWebhooks = %v, want ErrUnauthenticated", err)
	}
	if _, err := st.ListWorkspaceWebhooks(ctx, memberGuard, ws.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member ListWorkspaceWebhooks = %v, want ErrForbidden", err)
	}
	if _, err := st.CreateWorkspaceWebhookGuarded(ctx, memberGuard, ws.ID, validInput); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member CreateWorkspaceWebhookGuarded = %v, want ErrForbidden", err)
	}
	if _, err := st.CreateWorkspaceWebhookGuarded(ctx, outsiderGuard, ws.ID, validInput); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outsider CreateWorkspaceWebhookGuarded = %v, want ErrForbidden", err)
	}

	// Input validation checks.
	badCases := []struct {
		name string
		mut  func(*store.WorkspaceWebhookInput)
	}{
		{"empty name", func(in *store.WorkspaceWebhookInput) { in.Name = "   " }},
		{"name > 80 runes", func(in *store.WorkspaceWebhookInput) { in.Name = strings.Repeat("剑", 81) }},
		{"empty url", func(in *store.WorkspaceWebhookInput) { in.URL = "" }},
		{"ftp url", func(in *store.WorkspaceWebhookInput) { in.URL = "ftp://hooks.example.com/a" }},
		{"url with creds", func(in *store.WorkspaceWebhookInput) { in.URL = "https://user:pass@hooks.example.com/a" }},
		{"url with fragment", func(in *store.WorkspaceWebhookInput) { in.URL = "https://hooks.example.com/a#frag" }},
		{"empty events", func(in *store.WorkspaceWebhookInput) { in.Events = nil }},
		{"unknown event", func(in *store.WorkspaceWebhookInput) { in.Events = []string{"doc.created", "unknown.event"} }},
	}
	for _, tc := range badCases {
		in := validInput
		tc.mut(&in)
		if _, err := st.CreateWorkspaceWebhookGuarded(ctx, ownerGuard, ws.ID, in); !errors.Is(err, store.ErrConflict) {
			t.Fatalf("bad case %q: got %v, want ErrConflict", tc.name, err)
		}
	}

	// Owner creates webhook 1; events deduplicated & normalized; secret omitted from returned copy.
	wh1, err := st.CreateWorkspaceWebhookGuarded(ctx, ownerGuard, ws.ID, validInput)
	if err != nil {
		t.Fatalf("create wh1: %v", err)
	}
	if wh1.ID <= 0 || wh1.WorkspaceID != ws.ID || !wh1.HasSecret || wh1.SecretHint != "abcd" || len(wh1.SecretEnc) != 0 {
		t.Fatalf("unexpected wh1: %+v", wh1)
	}
	if len(wh1.Events) != 2 || wh1.Events[0] != store.WebhookEventDocCreated || wh1.Events[1] != store.WebhookEventDocDeleted {
		t.Fatalf("wh1.Events = %v, want [doc.created doc.deleted]", wh1.Events)
	}

	// Admin creates webhook 2 (disabled, different events).
	wh2, err := st.CreateWorkspaceWebhookGuarded(ctx, adminGuard, ws.ID, store.WorkspaceWebhookInput{
		Name:       "Base & Sheet Hook",
		URL:        "https://hooks.example.com/tables",
		SecretEnc:  []byte("sealed-secret-2"),
		SecretHint: "ef01",
		Events:     []string{store.WebhookEventBaseRecordMutated, store.WebhookEventSheetCellsUpdated, store.WebhookEventSlidesVersionCreated},
		Enabled:    false,
	})
	if err != nil {
		t.Fatalf("admin create wh2: %v", err)
	}

	// ListWorkspaceWebhooks returns both ordered by ID ASC, without SecretEnc.
	listed, err := st.ListWorkspaceWebhooks(ctx, adminGuard, ws.ID)
	if err != nil || len(listed) != 2 || listed[0].ID != wh1.ID || listed[1].ID != wh2.ID {
		t.Fatalf("ListWorkspaceWebhooks = %+v err=%v", listed, err)
	}
	if len(listed[0].SecretEnc) != 0 || !listed[0].HasSecret {
		t.Fatalf("listed[0] secret exposure wrong: %+v", listed[0])
	}

	// GetWorkspaceWebhookGuarded returns SecretEnc (including for disabled webhook), and JSON marshaling never leaks it.
	gotWH2, err := st.GetWorkspaceWebhookGuarded(ctx, adminGuard, ws.ID, wh2.ID)
	if err != nil || string(gotWH2.SecretEnc) != "sealed-secret-2" {
		t.Fatalf("GetWorkspaceWebhookGuarded wh2 = %+v err=%v", gotWH2, err)
	}
	rawJSON, err := json.Marshal(gotWH2)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rawJSON), "sealed-secret-2") || strings.Contains(string(rawJSON), "SecretEnc") {
		t.Fatalf("WorkspaceWebhook JSON leaked SecretEnc: %s", rawJSON)
	}
	if _, err := st.GetWorkspaceWebhookGuarded(ctx, outsiderGuard, otherWS.ID, wh2.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-workspace GetWorkspaceWebhookGuarded = %v, want ErrNotFound", err)
	}

	// ListEnabledWebhooksForEvent returns only enabled webhooks subscribed to the event, WITH SecretEnc.
	enabledDocCreated, err := st.ListEnabledWebhooksForEvent(ctx, ws.ID, store.WebhookEventDocCreated)
	if err != nil || len(enabledDocCreated) != 1 || enabledDocCreated[0].ID != wh1.ID || string(enabledDocCreated[0].SecretEnc) != "sealed-secret-ciphertext" {
		t.Fatalf("ListEnabledWebhooksForEvent(doc.created) = %+v err=%v", enabledDocCreated, err)
	}
	enabledBase, err := st.ListEnabledWebhooksForEvent(ctx, ws.ID, store.WebhookEventBaseRecordMutated)
	if err != nil || len(enabledBase) != 0 {
		t.Fatalf("disabled webhook returned by ListEnabledWebhooksForEvent: %+v err=%v", enabledBase, err)
	}

	// Update webhook 1 without changing secret -> preserves existing SecretEnc.
	newName := "CI Hook v2"
	updatedWH1, err := st.UpdateWorkspaceWebhookGuarded(ctx, ownerGuard, ws.ID, wh1.ID, store.WorkspaceWebhookPatch{
		Name: &newName,
	})
	if err != nil || updatedWH1.Name != "CI Hook v2" || !updatedWH1.HasSecret || updatedWH1.SecretHint != "abcd" {
		t.Fatalf("update wh1 = %+v err=%v", updatedWH1, err)
	}
	checkWH1, err := st.GetWorkspaceWebhookGuarded(ctx, ownerGuard, ws.ID, wh1.ID)
	if err != nil || string(checkWH1.SecretEnc) != "sealed-secret-ciphertext" {
		t.Fatalf("wh1 secret lost after non-secret update: %+v err=%v", checkWH1, err)
	}

	// Enable wh2 and rotate its secret.
	enabledTrue := true
	newEvents := []string{store.WebhookEventBaseRecordMutated, store.WebhookEventShareUpdated}
	updatedWH2, err := st.UpdateWorkspaceWebhookGuarded(ctx, adminGuard, ws.ID, wh2.ID, store.WorkspaceWebhookPatch{
		Enabled:      &enabledTrue,
		Events:       &newEvents,
		UpdateSecret: true,
		SecretEnc:    []byte("rotated-secret-2"),
		SecretHint:   "9999",
	})
	if err != nil || !updatedWH2.Enabled || updatedWH2.SecretHint != "9999" || len(updatedWH2.Events) != 2 {
		t.Fatalf("update wh2 = %+v err=%v", updatedWH2, err)
	}
	enabledBase, err = st.ListEnabledWebhooksForEvent(ctx, ws.ID, store.WebhookEventBaseRecordMutated)
	if err != nil || len(enabledBase) != 1 || enabledBase[0].ID != wh2.ID || string(enabledBase[0].SecretEnc) != "rotated-secret-2" {
		t.Fatalf("after enable ListEnabledWebhooksForEvent = %+v err=%v", enabledBase, err)
	}
	if _, err := st.UpdateWorkspaceWebhookGuarded(ctx, memberGuard, ws.ID, wh2.ID, store.WorkspaceWebhookPatch{Name: &newName}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member update = %v, want ErrForbidden", err)
	}

	// Deliveries: record 105 deliveries + verify newest-first ordering, UTF-8 truncation, max limit 100, and workspace isolation.
	longBody := strings.Repeat("测", 500) // 1500 bytes UTF-8
	for i := 1; i <= 105; i++ {
		d, err := st.RecordWebhookDelivery(ctx, store.WebhookDelivery{
			WebhookID:    wh1.ID,
			WorkspaceID:  ws.ID,
			EventType:    store.WebhookEventDocCreated,
			Payload:      json.RawMessage(fmt.Sprintf(`{"seq":%d}`, i)),
			StatusCode:   200,
			ResponseBody: longBody,
			Attempt:      1,
			Success:      true,
			ErrorMsg:     "",
			CreatedAt:    now.Add(time.Duration(i) * time.Second),
		})
		if err != nil {
			t.Fatalf("record delivery %d: %v", i, err)
		}
		if d.ID <= 0 || len(d.ResponseBody) > 1024 {
			t.Fatalf("delivery %d response not truncated properly: len=%d", i, len(d.ResponseBody))
		}
	}

	// Default limit (30) and cap at 100.
	defDeliveries, err := st.ListWebhookDeliveriesGuarded(ctx, adminGuard, ws.ID, wh1.ID, 0)
	if err != nil || len(defDeliveries) != store.WebhookDeliveriesDefaultLimit {
		t.Fatalf("default deliveries len = %d err=%v, want %d", len(defDeliveries), err, store.WebhookDeliveriesDefaultLimit)
	}
	maxDeliveries, err := st.ListWebhookDeliveriesGuarded(ctx, ownerGuard, ws.ID, wh1.ID, 500)
	if err != nil || len(maxDeliveries) != store.WebhookDeliveriesMaxLimit {
		t.Fatalf("capped deliveries len = %d err=%v, want %d", len(maxDeliveries), err, store.WebhookDeliveriesMaxLimit)
	}
	// Verify newest-first order (seq 105 first, then 104).
	if !strings.Contains(string(maxDeliveries[0].Payload), `"seq":105`) || !strings.Contains(string(maxDeliveries[1].Payload), `"seq":104`) {
		t.Fatalf("deliveries not newest-first: [0]=%s [1]=%s", maxDeliveries[0].Payload, maxDeliveries[1].Payload)
	}
	if _, err := st.ListWebhookDeliveriesGuarded(ctx, memberGuard, ws.ID, wh1.ID, 10); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member list deliveries = %v, want ErrForbidden", err)
	}
	if _, err := st.ListWebhookDeliveriesGuarded(ctx, outsiderGuard, otherWS.ID, wh1.ID, 10); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-workspace list deliveries = %v, want ErrNotFound", err)
	}

	// Enforce max 25 webhooks per workspace (currently have 2: wh1, wh2).
	var extraIDs []int64
	for i := 3; i <= store.MaxWebhooksPerWorkspace; i++ {
		w, err := st.CreateWorkspaceWebhookGuarded(ctx, ownerGuard, ws.ID, store.WorkspaceWebhookInput{
			Name:    fmt.Sprintf("Hook #%d", i),
			URL:     fmt.Sprintf("https://hooks.example.com/%d", i),
			Events:  []string{store.WebhookEventDocCreated},
			Enabled: true,
		})
		if err != nil {
			t.Fatalf("create hook #%d: %v", i, err)
		}
		extraIDs = append(extraIDs, w.ID)
	}
	if _, err := st.CreateWorkspaceWebhookGuarded(ctx, ownerGuard, ws.ID, validInput); !errors.Is(err, store.ErrWebhookLimitReached) || !errors.Is(err, store.ErrConflict) {
		t.Fatalf("26th webhook err = %v, want ErrWebhookLimitReached/ErrConflict", err)
	}
	// Another workspace is unaffected by ws's 25-webhook limit.
	otherHook, err := st.CreateWorkspaceWebhookGuarded(ctx, outsiderGuard, otherWS.ID, validInput)
	if err != nil || otherHook.WorkspaceID != otherWS.ID {
		t.Fatalf("other workspace create = %+v err=%v", otherHook, err)
	}

	// Delete webhook 1 -> removes webhook and its deliveries.
	if err := st.DeleteWorkspaceWebhookGuarded(ctx, memberGuard, ws.ID, wh1.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member delete = %v, want ErrForbidden", err)
	}
	if err := st.DeleteWorkspaceWebhookGuarded(ctx, ownerGuard, ws.ID, wh1.ID); err != nil {
		t.Fatalf("owner delete wh1: %v", err)
	}
	if _, err := st.ListWebhookDeliveriesGuarded(ctx, ownerGuard, ws.ID, wh1.ID, 10); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted wh1 deliveries = %v, want ErrNotFound", err)
	}
	if _, err := st.RecordWebhookDelivery(ctx, store.WebhookDelivery{
		WebhookID:   wh1.ID,
		WorkspaceID: ws.ID,
		EventType:   store.WebhookEventTest,
	}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("record delivery for deleted webhook = %v, want ErrNotFound", err)
	}
	// Clean up extra webhooks.
	for _, id := range extraIDs {
		if err := st.DeleteWorkspaceWebhookGuarded(ctx, ownerGuard, ws.ID, id); err != nil {
			t.Fatalf("cleanup delete %d: %v", id, err)
		}
	}
}

func TestWebhooksMemory(t *testing.T) {
	exerciseWebhookStore(t, store.NewMemory())
}

func TestWebhooksPostgres(t *testing.T) {
	dsn := os.Getenv("JIANGE_TEST_DB")
	if dsn == "" {
		t.Skip("JIANGE_TEST_DB not set")
	}
	ctx := context.Background()
	pg, err := store.NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseWebhookStore(t, pg)
}
