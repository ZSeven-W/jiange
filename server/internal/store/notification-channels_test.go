package store_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseNotificationChannels(t *testing.T, st store.Store) {
	t.Helper()
	ns, ok := st.(store.NotificationChannelStore)
	if !ok {
		t.Fatalf("store does not implement NotificationChannelStore")
	}
	ctx := context.Background()

	owner, ws, err := st.CreateUser(ctx, "nc-owner@example.test", "NC Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	member, otherWS, err := st.CreateUser(ctx, "nc-member@example.test", "NC Member", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AddWorkspaceMember(ctx, ws.ID, member.ID); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	ownerGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("nc-owner-sess"), Now: func() time.Time { return now }}
	memberGuard := store.RestoreGuard{UserID: member.ID, SessionHash: []byte("nc-member-sess"), Now: func() time.Time { return now }}
	if err := st.CreateSession(ctx, ownerGuard.SessionHash, owner.ID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateSession(ctx, memberGuard.SessionHash, member.ID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	// Regular member cannot list or create channels.
	if _, err := ns.ListNotificationChannels(ctx, memberGuard, ws.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member list err = %v, want ErrForbidden", err)
	}
	if _, err := ns.CreateNotificationChannel(ctx, memberGuard, ws.ID, store.NotificationChannelInput{
		Name:      "Blocked",
		Kind:      store.NotificationChannelKindSlackBot,
		ConfigEnc: []byte("enc"),
		Events:    []string{store.NotificationEventMention},
		Enabled:   true,
	}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member create err = %v, want ErrForbidden", err)
	}

	// Validation checks.
	if _, err := ns.CreateNotificationChannel(ctx, ownerGuard, ws.ID, store.NotificationChannelInput{
		Name:      "Bad Kind",
		Kind:      "telegram_bot",
		ConfigEnc: []byte("enc"),
		Events:    []string{store.NotificationEventMention},
		Enabled:   true,
	}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid kind err = %v, want ErrConflict", err)
	}
	if _, err := ns.CreateNotificationChannel(ctx, ownerGuard, ws.ID, store.NotificationChannelInput{
		Name:      "Empty Config",
		Kind:      store.NotificationChannelKindFeishuBot,
		ConfigEnc: nil,
		Events:    []string{store.NotificationEventMention},
		Enabled:   true,
	}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("empty config err = %v, want ErrConflict", err)
	}
	if _, err := ns.CreateNotificationChannel(ctx, ownerGuard, ws.ID, store.NotificationChannelInput{
		Name:      "Bad Event",
		Kind:      store.NotificationChannelKindFeishuBot,
		ConfigEnc: []byte("enc"),
		Events:    []string{"unknown_event"},
		Enabled:   true,
	}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid event err = %v, want ErrConflict", err)
	}

	// Create valid channel.
	sealed := []byte("sealed-feishu-payload")
	created, err := ns.CreateNotificationChannel(ctx, ownerGuard, ws.ID, store.NotificationChannelInput{
		Name:       "研发飞书群",
		Kind:       store.NotificationChannelKindFeishuBot,
		ConfigEnc:  sealed,
		ConfigHint: "https://open.feishu.cn/...abcd",
		Events:     []string{"mention", "comment_reply", "mention"},
		Enabled:    true,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID <= 0 || created.WorkspaceID != ws.ID || created.Kind != store.NotificationChannelKindFeishuBot {
		t.Fatalf("unexpected created channel: %+v", created)
	}
	if len(created.ConfigEnc) != 0 {
		t.Fatalf("CreateNotificationChannel must strip ConfigEnc, got %d bytes", len(created.ConfigEnc))
	}
	if len(created.Events) != 2 || created.Events[0] != "mention" || created.Events[1] != "comment_reply" {
		t.Fatalf("deduplicated events = %v", created.Events)
	}
	// JSON serialization never exposes ConfigEnc.
	rawJSON, err := json.Marshal(created)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(rawJSON, []byte("configEnc")) || bytes.Contains(rawJSON, sealed) {
		t.Fatalf("ConfigEnc leaked in JSON: %s", rawJSON)
	}

	// GetNotificationChannel returns ConfigEnc for server-side dispatch.
	fetched, err := ns.GetNotificationChannel(ctx, ownerGuard, ws.ID, created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !bytes.Equal(fetched.ConfigEnc, sealed) {
		t.Fatalf("fetched ConfigEnc = %q, want %q", fetched.ConfigEnc, sealed)
	}
	// Cross-workspace isolation.
	if _, err := ns.GetNotificationChannel(ctx, memberGuard, otherWS.ID, created.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-workspace get err = %v, want ErrNotFound", err)
	}

	// ListNotificationChannels strips ConfigEnc.
	list, err := ns.ListNotificationChannels(ctx, ownerGuard, ws.ID)
	if err != nil || len(list) != 1 || len(list[0].ConfigEnc) != 0 {
		t.Fatalf("list = %+v err=%v", list, err)
	}

	// ListActiveNotificationChannelsForEvent returns enabled matching channels with ConfigEnc.
	active, err := ns.ListActiveNotificationChannelsForEvent(ctx, ws.ID, store.NotificationEventMention)
	if err != nil || len(active) != 1 || !bytes.Equal(active[0].ConfigEnc, sealed) {
		t.Fatalf("active mention = %+v err=%v", active, err)
	}
	activeAuto, err := ns.ListActiveNotificationChannelsForEvent(ctx, ws.ID, store.NotificationEventAutomation)
	if err != nil || len(activeAuto) != 0 {
		t.Fatalf("active automation = %+v err=%v", activeAuto, err)
	}

	// RecordNotificationChannelDelivery updates last_status / last_error / last_sent_at.
	sentAt := now.Add(2 * time.Minute).Truncate(time.Second)
	if err := ns.RecordNotificationChannelDelivery(ctx, ws.ID, created.ID, "ok", "", sentAt); err != nil {
		t.Fatalf("record ok delivery: %v", err)
	}
	afterOK, err := ns.GetNotificationChannel(ctx, ownerGuard, ws.ID, created.ID)
	if err != nil || afterOK.LastStatus != "ok" || afterOK.LastError != "" || afterOK.LastSentAt == nil {
		t.Fatalf("after ok delivery = %+v err=%v", afterOK, err)
	}
	if err := ns.RecordNotificationChannelDelivery(ctx, ws.ID, created.ID, "error", "timeout connecting to peer", sentAt.Add(time.Minute)); err != nil {
		t.Fatalf("record error delivery: %v", err)
	}
	afterErr, err := ns.GetNotificationChannel(ctx, ownerGuard, ws.ID, created.ID)
	if err != nil || afterErr.LastStatus != "error" || afterErr.LastError != "timeout connecting to peer" {
		t.Fatalf("after error delivery = %+v err=%v", afterErr, err)
	}

	// Update channel: rename, disable, switch events, keep config intact when UpdateConfig=false.
	newName := "产品告警群"
	disabled := false
	newEvents := []string{store.NotificationEventAutomation, store.NotificationEventShareUpdated}
	updated, err := ns.UpdateNotificationChannel(ctx, ownerGuard, ws.ID, created.ID, store.NotificationChannelPatch{
		Name:    &newName,
		Enabled: &disabled,
		Events:  &newEvents,
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Name != newName || updated.Enabled || len(updated.Events) != 2 || len(updated.ConfigEnc) != 0 {
		t.Fatalf("updated = %+v", updated)
	}
	// Disabled channel must not appear in ListActiveNotificationChannelsForEvent.
	activeAfterDisable, err := ns.ListActiveNotificationChannelsForEvent(ctx, ws.ID, store.NotificationEventAutomation)
	if err != nil || len(activeAfterDisable) != 0 {
		t.Fatalf("disabled channel returned as active: %+v err=%v", activeAfterDisable, err)
	}
	// UpdateConfig replaces sealed config and hint.
	newSealed := []byte("sealed-updated-config")
	updated2, err := ns.UpdateNotificationChannel(ctx, ownerGuard, ws.ID, created.ID, store.NotificationChannelPatch{
		UpdateConfig: true,
		ConfigEnc:    newSealed,
		ConfigHint:   "smtp.example.com:587 -> ops@example.com",
	})
	if err != nil || updated2.ConfigHint != "smtp.example.com:587 -> ops@example.com" {
		t.Fatalf("update config = %+v err=%v", updated2, err)
	}
	fetched2, err := ns.GetNotificationChannel(ctx, ownerGuard, ws.ID, created.ID)
	if err != nil || !bytes.Equal(fetched2.ConfigEnc, newSealed) {
		t.Fatalf("fetched2 ConfigEnc = %q, want %q err=%v", fetched2.ConfigEnc, newSealed, err)
	}

	// Delete channel.
	if err := ns.DeleteNotificationChannel(ctx, ownerGuard, ws.ID, created.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := ns.GetNotificationChannel(ctx, ownerGuard, ws.ID, created.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("get after delete = %v, want ErrNotFound", err)
	}

	// Enforce MaxNotificationChannelsPerWorkspace = 20.
	for i := 0; i < store.MaxNotificationChannelsPerWorkspace; i++ {
		_, err := ns.CreateNotificationChannel(ctx, ownerGuard, ws.ID, store.NotificationChannelInput{
			Name:       fmt.Sprintf("Channel %d", i+1),
			Kind:       store.NotificationChannelKindSlackBot,
			ConfigEnc:  []byte(fmt.Sprintf("enc-%d", i)),
			ConfigHint: "https://hooks.slack.com/...1234",
			Events:     []string{store.NotificationEventMention},
			Enabled:    true,
		})
		if err != nil {
			t.Fatalf("create #%d: %v", i+1, err)
		}
	}
	if _, err := ns.CreateNotificationChannel(ctx, ownerGuard, ws.ID, store.NotificationChannelInput{
		Name:       "Overflow Channel",
		Kind:       store.NotificationChannelKindSlackBot,
		ConfigEnc:  []byte("enc-overflow"),
		ConfigHint: "https://hooks.slack.com/...9999",
		Events:     []string{store.NotificationEventMention},
		Enabled:    true,
	}); !errors.Is(err, store.ErrNotificationChannelLimitReached) {
		t.Fatalf("overflow create err = %v, want ErrNotificationChannelLimitReached", err)
	}
}

func TestNotificationChannelStoreMemory(t *testing.T) {
	exerciseNotificationChannels(t, store.NewMemory())
}

func TestNotificationChannelStorePostgres(t *testing.T) {
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
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	exerciseNotificationChannels(t, pg)
}
