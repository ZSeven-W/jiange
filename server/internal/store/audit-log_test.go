package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

type auditTestStore interface {
	store.Store
	store.AuditLogStore
}

func setupAuditUsers(t *testing.T, st auditTestStore) (
	ws store.Workspace,
	otherWS store.Workspace,
	owner, admin, member, outsider store.User,
	ownerGuard, adminGuard, memberGuard, outsiderGuard store.RestoreGuard,
) {
	t.Helper()
	ctx := context.Background()
	exp := time.Now().Add(time.Hour)

	var err error
	owner, ws, err = st.CreateUser(ctx, "audit-owner@example.test", "Owner Lin", "hash")
	if err != nil {
		t.Fatal(err)
	}
	admin, _, err = st.CreateUser(ctx, "audit-admin@example.test", "Admin Chen", "hash")
	if err != nil {
		t.Fatal(err)
	}
	member, _, err = st.CreateUser(ctx, "audit-member@example.test", "Member Zhou", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, otherWS, err = st.CreateUser(ctx, "audit-out@example.test", "Outsider Wu", "hash")
	if err != nil {
		t.Fatal(err)
	}

	makeGuard := func(u store.User, tag string) store.RestoreGuard {
		g := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("audit-sess-" + tag)}
		if e := st.CreateSession(ctx, g.SessionHash, u.ID, exp); e != nil {
			t.Fatal(e)
		}
		return g
	}
	ownerGuard = makeGuard(owner, "owner")
	adminGuard = makeGuard(admin, "admin")
	memberGuard = makeGuard(member, "member")
	outsiderGuard = makeGuard(outsider, "outsider")

	// Invite and accept admin & member.
	for _, tc := range []struct {
		u    store.User
		g    store.RestoreGuard
		role string
	}{
		{admin, adminGuard, store.WorkspaceRoleAdmin},
		{member, memberGuard, store.WorkspaceRoleMember},
	} {
		ch, err := st.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, tc.u.Email, tc.role)
		if err != nil || ch.Invitation == nil {
			t.Fatalf("invite %s: %+v err=%v", tc.u.Email, ch, err)
		}
		if err := st.RespondInvitationGuarded(ctx, tc.g, ch.Invitation.ID, true); err != nil {
			t.Fatalf("accept %s: %v", tc.u.Email, err)
		}
	}
	return
}

func exerciseAuditLogs(t *testing.T, st auditTestStore) {
	t.Helper()
	ctx := context.Background()
	ws, otherWS, owner, admin, member, outsider, ownerGuard, adminGuard, memberGuard, outsiderGuard := setupAuditUsers(t, st)

	// Empty action is rejected.
	if err := st.AppendAuditLog(ctx, store.AuditLogEntry{WorkspaceID: ws.ID, Action: "   "}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("empty action err = %v, want ErrConflict", err)
	}

	baseTime := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	longTitle := strings.Repeat("机密方案", 100) // 400 runes -> clamped to 300 runes

	entries := []store.AuditLogEntry{
		{
			WorkspaceID:   ws.ID,
			ActorID:       owner.ID,
			ActorName:     owner.Name,
			ActorEmail:    owner.Email,
			Action:        "auth.login",
			ResourceType:  "session",
			ResourceID:    0,
			ResourceTitle: "Web 登录",
			Detail:        nil, // should normalize to {}
			IPAddress:     "10.0.1.10",
			UserAgent:     "Mozilla/5.0",
			CreatedAt:     baseTime,
		},
		{
			WorkspaceID:   ws.ID,
			ActorID:       admin.ID,
			ActorName:     admin.Name,
			ActorEmail:    admin.Email,
			Action:        "doc.create",
			ResourceType:  "doc",
			ResourceID:    101,
			ResourceTitle: longTitle,
			Detail:        json.RawMessage(`{"kind":"doc"}`),
			IPAddress:     "10.0.1.20",
			UserAgent:     "Chrome/130",
			CreatedAt:     baseTime.Add(1 * time.Minute),
		},
		{
			WorkspaceID:   ws.ID,
			ActorID:       member.ID,
			ActorName:     member.Name,
			ActorEmail:    member.Email,
			Action:        "share.update",
			ResourceType:  "doc",
			ResourceID:    101,
			ResourceTitle: "Q4 架构设计",
			Detail:        json.RawMessage(`not-valid-json`), // should normalize to {}
			IPAddress:     "192.168.5.42",
			UserAgent:     "Safari/18",
			CreatedAt:     baseTime.Add(2 * time.Minute),
		},
		{
			WorkspaceID:   ws.ID,
			ActorID:       admin.ID,
			ActorName:     admin.Name,
			ActorEmail:    admin.Email,
			Action:        "org.watermark_update",
			ResourceType:  "workspace",
			ResourceID:    ws.ID,
			ResourceTitle: "Watermark Policy",
			Detail:        json.RawMessage(`{"enabled":true}`),
			IPAddress:     "10.0.1.20",
			UserAgent:     "Chrome/130",
			CreatedAt:     baseTime.Add(2 * time.Minute), // same timestamp -> tie-broken by id DESC
		},
		// Other workspace record must not leak into ws.ID queries.
		{
			WorkspaceID:   otherWS.ID,
			ActorID:       outsider.ID,
			ActorName:     outsider.Name,
			ActorEmail:    outsider.Email,
			Action:        "doc.delete",
			ResourceType:  "doc",
			ResourceID:    999,
			ResourceTitle: "Secret Other Workspace",
			IPAddress:     "172.16.0.1",
			CreatedAt:     baseTime.Add(3 * time.Minute),
		},
	}
	for i, e := range entries {
		if err := st.AppendAuditLog(ctx, e); err != nil {
			t.Fatalf("append[%d]: %v", i, err)
		}
	}

	// Regular member and outsider cannot read audit logs.
	if _, err := st.ListAuditLogsGuarded(ctx, memberGuard, ws.ID, store.AuditLogFilter{}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member ListAuditLogsGuarded = %v, want ErrForbidden", err)
	}
	if _, err := st.ListAuditLogsGuarded(ctx, outsiderGuard, ws.ID, store.AuditLogFilter{}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outsider ListAuditLogsGuarded = %v, want ErrForbidden", err)
	}
	// Invalid session rejected.
	badGuard := store.RestoreGuard{UserID: owner.ID, SessionHash: []byte("nonexistent")}
	if _, err := st.ListAuditLogsGuarded(ctx, badGuard, ws.ID, store.AuditLogFilter{}); !errors.Is(err, store.ErrUnauthenticated) {
		t.Fatalf("bad session ListAuditLogsGuarded = %v, want ErrUnauthenticated", err)
	}

	// Owner sees all 4 workspace events newest-first (created_at DESC, id DESC).
	page, err := st.ListAuditLogsGuarded(ctx, ownerGuard, ws.ID, store.AuditLogFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 4 || len(page.Items) != 4 {
		t.Fatalf("owner page total=%d len=%d, want 4", page.Total, len(page.Items))
	}
	wantOrder := []string{"org.watermark_update", "share.update", "doc.create", "auth.login"}
	for i, want := range wantOrder {
		if page.Items[i].Action != want {
			t.Fatalf("item[%d].Action = %q, want %q", i, page.Items[i].Action, want)
		}
	}
	// Verify length clamping and detail normalization.
	if got := utf8.RuneCountInString(page.Items[2].ResourceTitle); got != 300 {
		t.Fatalf("clamped ResourceTitle runes = %d, want 300", got)
	}
	if string(page.Items[3].Detail) != "{}" || string(page.Items[1].Detail) != "{}" {
		t.Fatalf("normalized detail = %q, %q; want {}", string(page.Items[3].Detail), string(page.Items[1].Detail))
	}
	// Actions list is distinct and sorted, scoped only to ws.ID (no doc.delete).
	wantActions := []string{"auth.login", "doc.create", "org.watermark_update", "share.update"}
	if strings.Join(page.Actions, ",") != strings.Join(wantActions, ",") {
		t.Fatalf("actions = %v, want %v", page.Actions, wantActions)
	}

	// Admin can also read audit logs with multi-filter combinations.
	byAction, err := st.ListAuditLogsGuarded(ctx, adminGuard, ws.ID, store.AuditLogFilter{
		Action:       "doc.create",
		ResourceType: "doc",
		ActorID:      admin.ID,
	})
	if err != nil || byAction.Total != 1 || len(byAction.Items) != 1 || byAction.Items[0].ResourceID != 101 {
		t.Fatalf("multi-filter = %+v err=%v", byAction, err)
	}

	// Keyword query matches actor_name, actor_email, resource_title, action, ip_address.
	for _, tc := range []struct {
		q    string
		want int
	}{
		{"CHEN", 2},         // actor_name / email
		{"192.168.5.42", 1}, // ip_address
		{"架构设计", 1},         // resource_title
		{"watermark", 1},    // action & resource_title
		{"Secret Other", 0}, // other workspace must never match
	} {
		res, err := st.ListAuditLogsGuarded(ctx, ownerGuard, ws.ID, store.AuditLogFilter{Query: tc.q})
		if err != nil || res.Total != tc.want {
			t.Fatalf("query %q: total=%d want=%d err=%v", tc.q, res.Total, tc.want, err)
		}
	}

	// Time window filtering (From / To).
	from := baseTime.Add(30 * time.Second)
	to := baseTime.Add(90 * time.Second)
	ranged, err := st.ListAuditLogsGuarded(ctx, ownerGuard, ws.ID, store.AuditLogFilter{From: &from, To: &to})
	if err != nil || ranged.Total != 1 || ranged.Items[0].Action != "doc.create" {
		t.Fatalf("time range = %+v err=%v", ranged, err)
	}

	// Pagination.
	p1, err := st.ListAuditLogsGuarded(ctx, ownerGuard, ws.ID, store.AuditLogFilter{Limit: 2, Offset: 0})
	if err != nil || p1.Total != 4 || len(p1.Items) != 2 || p1.Items[0].Action != "org.watermark_update" {
		t.Fatalf("page 1 = %+v err=%v", p1, err)
	}
	p2, err := st.ListAuditLogsGuarded(ctx, ownerGuard, ws.ID, store.AuditLogFilter{Limit: 2, Offset: 2})
	if err != nil || p2.Total != 4 || len(p2.Items) != 2 || p2.Items[0].Action != "doc.create" || p2.Items[1].Action != "auth.login" {
		t.Fatalf("page 2 = %+v err=%v", p2, err)
	}
	pOut, err := st.ListAuditLogsGuarded(ctx, ownerGuard, ws.ID, store.AuditLogFilter{Limit: 2, Offset: 10})
	if err != nil || pOut.Total != 4 || len(pOut.Items) != 0 {
		t.Fatalf("out-of-range page = %+v err=%v", pOut, err)
	}

	// Limit clamping: max 200 normally, up to 5000 when Export is true.
	for i := 0; i < 210; i++ {
		if err := st.AppendAuditLog(ctx, store.AuditLogEntry{
			WorkspaceID: ws.ID,
			ActorID:     owner.ID,
			Action:      "doc.view",
			ResourceID:  int64(i + 1),
			CreatedAt:   baseTime.Add(time.Duration(i+10) * time.Second),
		}); err != nil {
			t.Fatal(err)
		}
	}
	capped, err := st.ListAuditLogsGuarded(ctx, ownerGuard, ws.ID, store.AuditLogFilter{Limit: 500})
	if err != nil || capped.Total != 214 || len(capped.Items) != 200 {
		t.Fatalf("normal limit clamp: total=%d len=%d err=%v", capped.Total, len(capped.Items), err)
	}
	exported, err := st.ListAuditLogsGuarded(ctx, ownerGuard, ws.ID, store.AuditLogFilter{Limit: 5000, Export: true})
	if err != nil || exported.Total != 214 || len(exported.Items) != 214 {
		t.Fatalf("export limit: total=%d len=%d err=%v", exported.Total, len(exported.Items), err)
	}
}

func exerciseWorkspaceSecurityPolicy(t *testing.T, st auditTestStore) {
	t.Helper()
	ctx := context.Background()
	ws, _, owner, admin, member, outsider, ownerGuard, adminGuard, memberGuard, outsiderGuard := setupAuditUsers(t, st)

	// Default policy readable by any workspace member.
	for _, u := range []store.User{owner, admin, member} {
		pol, err := st.GetWorkspaceSecurityPolicy(ctx, u.ID, ws.ID)
		if err != nil {
			t.Fatalf("GetWorkspaceSecurityPolicy(%s): %v", u.Email, err)
		}
		if pol.WorkspaceID != ws.ID || pol.WatermarkEnabled || !pol.WatermarkShowUser || !pol.WatermarkShowEmail || !pol.WatermarkShowDate || pol.WatermarkOpacity != store.DefaultWatermarkOpacity {
			t.Fatalf("default policy for %s = %+v", u.Email, pol)
		}
		if pol.DLPEnabled || pol.DLPKeywords == nil || len(pol.DLPKeywords) != 0 || pol.DLPAction != store.DLPActionWarn || !pol.DLPBlockPublicShare || pol.RetentionDays != 0 {
			t.Fatalf("default DLP/retention policy for %s = %+v", u.Email, pol)
		}
		rawJSON, err := json.Marshal(pol)
		if err != nil {
			t.Fatalf("marshal default policy: %v", err)
		}
		if !strings.Contains(string(rawJSON), `"dlpKeywords":[]`) {
			t.Fatalf("expected non-nil empty dlpKeywords JSON [], got %s", string(rawJSON))
		}
	}

	// Outsider cannot read; nonexistent workspace returns ErrNotFound.
	if _, err := st.GetWorkspaceSecurityPolicy(ctx, outsider.ID, ws.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outsider GetWorkspaceSecurityPolicy = %v, want ErrForbidden", err)
	}
	if _, err := st.GetWorkspaceSecurityPolicy(ctx, owner.ID, 99999); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing ws GetWorkspaceSecurityPolicy = %v, want ErrNotFound", err)
	}

	// Regular member & outsider cannot update policy.
	enTrue := true
	if _, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, memberGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{WatermarkEnabled: &enTrue}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member update policy = %v, want ErrForbidden", err)
	}
	if _, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, outsiderGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{WatermarkEnabled: &enTrue}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outsider update policy = %v, want ErrForbidden", err)
	}

	// Owner updates policy with bounds clamping (text > 80 runes, opacity > 0.25).
	longPrefix := "  " + strings.Repeat("内部机密", 30) + "  " // 120 runes -> clamped to 80
	tooHigh := 0.99
	showEmailFalse := false
	updated, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, ownerGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		WatermarkEnabled:   &enTrue,
		WatermarkText:      &longPrefix,
		WatermarkShowEmail: &showEmailFalse,
		WatermarkOpacity:   &tooHigh,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.WatermarkEnabled || updated.WatermarkShowEmail || !updated.WatermarkShowUser || !updated.WatermarkShowDate {
		t.Fatalf("unexpected flags after owner update: %+v", updated)
	}
	if utf8.RuneCountInString(updated.WatermarkText) != store.MaxWatermarkTextRunes {
		t.Fatalf("clamped WatermarkText runes = %d, want %d", utf8.RuneCountInString(updated.WatermarkText), store.MaxWatermarkTextRunes)
	}
	if updated.WatermarkOpacity != store.MaxWatermarkOpacity {
		t.Fatalf("clamped high opacity = %v, want %v", updated.WatermarkOpacity, store.MaxWatermarkOpacity)
	}
	if updated.UpdatedBy != owner.ID || updated.UpdatedAt.IsZero() {
		t.Fatalf("updated metadata = by:%d at:%v", updated.UpdatedBy, updated.UpdatedAt)
	}

	// Admin updates opacity below minimum (clamped to 0.02) and verifies partial patch preserves earlier fields.
	tooLow := 0.001
	updated2, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, adminGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		WatermarkOpacity: &tooLow,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated2.WatermarkOpacity != store.MinWatermarkOpacity {
		t.Fatalf("clamped low opacity = %v, want %v", updated2.WatermarkOpacity, store.MinWatermarkOpacity)
	}
	if !updated2.WatermarkEnabled || updated2.WatermarkShowEmail || updated2.WatermarkText != updated.WatermarkText {
		t.Fatalf("partial patch lost previous values: %+v", updated2)
	}
	if updated2.UpdatedBy != admin.ID {
		t.Fatalf("UpdatedBy = %d, want admin %d", updated2.UpdatedBy, admin.ID)
	}

	// NaN opacity falls back to default (0.07).
	nanVal := math.NaN()
	updated3, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, adminGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		WatermarkOpacity: &nanVal,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated3.WatermarkOpacity != store.DefaultWatermarkOpacity {
		t.Fatalf("NaN opacity = %v, want default %v", updated3.WatermarkOpacity, store.DefaultWatermarkOpacity)
	}

	// Regular member reads the persisted policy.
	readBack, err := st.GetWorkspaceSecurityPolicy(ctx, member.ID, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if readBack.WatermarkEnabled != updated3.WatermarkEnabled || readBack.WatermarkText != updated3.WatermarkText || readBack.WatermarkOpacity != updated3.WatermarkOpacity {
		t.Fatalf("member readBack = %+v, want %+v", readBack, updated3)
	}

	// DLP + Data Retention validation failures must return ErrInvalidSecurityPolicy (wrapping ErrConflict).
	badAction := "drop"
	if _, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, ownerGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		DLPAction: &badAction,
	}); !errors.Is(err, store.ErrInvalidSecurityPolicy) || !errors.Is(err, store.ErrConflict) {
		t.Fatalf("invalid dlpAction err = %v, want ErrInvalidSecurityPolicy", err)
	}
	for _, badDays := range []int{-1, 3651} {
		d := badDays
		if _, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, ownerGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
			RetentionDays: &d,
		}); !errors.Is(err, store.ErrInvalidSecurityPolicy) {
			t.Fatalf("invalid retentionDays=%d err = %v, want ErrInvalidSecurityPolicy", badDays, err)
		}
	}
	tooManyKeywords := make([]string, store.MaxDLPKeywords+1)
	for i := range tooManyKeywords {
		tooManyKeywords[i] = fmt.Sprintf("kw-%03d", i)
	}
	if _, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, ownerGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		DLPKeywords: &tooManyKeywords,
	}); !errors.Is(err, store.ErrInvalidSecurityPolicy) {
		t.Fatalf("101 dlpKeywords err = %v, want ErrInvalidSecurityPolicy", err)
	}
	tooLongKeyword := []string{strings.Repeat("密", store.MaxDLPKeywordRunes+1)}
	if _, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, ownerGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		DLPKeywords: &tooLongKeyword,
	}); !errors.Is(err, store.ErrInvalidSecurityPolicy) {
		t.Fatalf("121-rune dlpKeyword err = %v, want ErrInvalidSecurityPolicy", err)
	}

	// Valid DLP + retention full round-trip (including trim, blank drop, deduplication, and action normalization).
	dlpOn := true
	blockPublicFalse := false
	actionBlock := " BLOCK "
	days90 := 90
	rawKeywords := []string{"  绝密  ", "", "   ", "内部机密", "绝密", `/1[3-9]\d{9}/`}
	dlpSaved, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, ownerGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		DLPEnabled:          &dlpOn,
		DLPKeywords:         &rawKeywords,
		DLPAction:           &actionBlock,
		DLPBlockPublicShare: &blockPublicFalse,
		RetentionDays:       &days90,
	})
	if err != nil {
		t.Fatalf("save DLP policy: %v", err)
	}
	wantKW := []string{"绝密", "内部机密", `/1[3-9]\d{9}/`}
	if !dlpSaved.DLPEnabled || dlpSaved.DLPAction != store.DLPActionBlock || dlpSaved.DLPBlockPublicShare || dlpSaved.RetentionDays != 90 || strings.Join(dlpSaved.DLPKeywords, "|") != strings.Join(wantKW, "|") {
		t.Fatalf("unexpected saved DLP policy: %+v", dlpSaved)
	}
	// Mutating returned slice must not corrupt store internals.
	dlpSaved.DLPKeywords[0] = "tampered"

	// Partial update preserves DLP + retention fields and max boundary values (100 keywords, 3650 days).
	maxKeywords := make([]string, store.MaxDLPKeywords)
	for i := range maxKeywords {
		maxKeywords[i] = fmt.Sprintf("rule-%03d", i)
	}
	daysMax := store.MaxRetentionDays
	blockPublicTrue := true
	dlpBoundary, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, adminGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		DLPKeywords:         &maxKeywords,
		DLPBlockPublicShare: &blockPublicTrue,
		RetentionDays:       &daysMax,
	})
	if err != nil {
		t.Fatalf("save boundary DLP policy: %v", err)
	}
	if !dlpBoundary.DLPEnabled || dlpBoundary.DLPAction != store.DLPActionBlock || !dlpBoundary.DLPBlockPublicShare || dlpBoundary.RetentionDays != store.MaxRetentionDays || len(dlpBoundary.DLPKeywords) != store.MaxDLPKeywords {
		t.Fatalf("unexpected boundary DLP policy: %+v", dlpBoundary)
	}

	// Clearing keywords keeps non-nil empty JSON array [].
	emptyKW := []string{"  ", ""}
	daysZero := 0
	dlpCleared, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, ownerGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		DLPKeywords:   &emptyKW,
		RetentionDays: &daysZero,
	})
	if err != nil {
		t.Fatalf("clear DLP keywords: %v", err)
	}
	if dlpCleared.DLPKeywords == nil || len(dlpCleared.DLPKeywords) != 0 || dlpCleared.RetentionDays != 0 {
		t.Fatalf("expected non-nil empty dlpKeywords & retentionDays=0, got %+v", dlpCleared)
	}
	readBack2, err := st.GetWorkspaceSecurityPolicy(ctx, member.ID, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !readBack2.DLPEnabled || readBack2.DLPAction != store.DLPActionBlock || !readBack2.DLPBlockPublicShare || readBack2.DLPKeywords == nil || len(readBack2.DLPKeywords) != 0 || readBack2.RetentionDays != 0 || readBack2.RequireMFA {
		t.Fatalf("readBack2 DLP mismatch: %+v", readBack2)
	}

	// Workspace-Enforced MFA Policy toggle + UserHasMFARequiredWorkspace helper.
	reqBefore, wsBefore, err := st.UserHasMFARequiredWorkspace(ctx, member.ID)
	if err != nil || reqBefore || len(wsBefore) != 0 {
		t.Fatalf("before RequireMFA: (%v, %v, %v), want (false, [], nil)", reqBefore, wsBefore, err)
	}
	reqMFATrue := true
	mfaPol, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, ownerGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		RequireMFA: &reqMFATrue,
	})
	if err != nil {
		t.Fatalf("enable RequireMFA: %v", err)
	}
	if !mfaPol.RequireMFA || !mfaPol.DLPEnabled {
		t.Fatalf("expected RequireMFA=true and preserved DLPEnabled=true, got %+v", mfaPol)
	}
	// Owner, admin, and member belong to ws -> UserHasMFARequiredWorkspace returns true + ws.Name.
	for _, u := range []store.User{owner, admin, member} {
		req, names, err := st.UserHasMFARequiredWorkspace(ctx, u.ID)
		if err != nil || !req || len(names) != 1 || names[0] != ws.Name {
			t.Fatalf("UserHasMFARequiredWorkspace(%s) = (%v, %v, %v), want (true, [%q], nil)", u.Email, req, names, err, ws.Name)
		}
	}
	// Outsider is NOT in ws -> false.
	reqOut, namesOut, err := st.UserHasMFARequiredWorkspace(ctx, outsider.ID)
	if err != nil || reqOut || len(namesOut) != 0 {
		t.Fatalf("outsider UserHasMFARequiredWorkspace = (%v, %v, %v), want (false, [], nil)", reqOut, namesOut, err)
	}
	// Turning RequireMFA back off clears enforcement.
	reqMFAFalse := false
	mfaPolOff, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, adminGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		RequireMFA: &reqMFAFalse,
	})
	if err != nil || mfaPolOff.RequireMFA {
		t.Fatalf("disable RequireMFA = (%+v, %v)", mfaPolOff, err)
	}
	reqAfter, namesAfter, err := st.UserHasMFARequiredWorkspace(ctx, member.ID)
	if err != nil || reqAfter || len(namesAfter) != 0 {
		t.Fatalf("after disabling RequireMFA = (%v, %v, %v), want (false, [], nil)", reqAfter, namesAfter, err)
	}

	_ = fmt.Sprint(readBack2)
}

func exerciseRetentionPurge(t *testing.T, st auditTestStore) {
	t.Helper()
	ctx := context.Background()
	ws, otherWS, owner, _, _, outsider, ownerGuard, _, _, outsiderGuard := setupAuditUsers(t, st)

	// Initially no workspaces have retention_days > 0.
	policies, err := st.ListRetentionPolicies(ctx)
	if err != nil {
		t.Fatalf("initial ListRetentionPolicies: %v", err)
	}
	if len(policies) != 0 {
		t.Fatalf("expected 0 retention policies initially, got %+v", policies)
	}

	// Set ws to 30 days and otherWS to 0 (disabled).
	days30 := 30
	days0 := 0
	if _, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, ownerGuard, ws.ID, store.WorkspaceSecurityPolicyPatch{
		RetentionDays: &days30,
	}); err != nil {
		t.Fatalf("set ws retention 30d: %v", err)
	}
	if _, err := st.UpdateWorkspaceSecurityPolicyGuarded(ctx, outsiderGuard, otherWS.ID, store.WorkspaceSecurityPolicyPatch{
		RetentionDays: &days0,
	}); err != nil {
		t.Fatalf("set otherWS retention 0d: %v", err)
	}

	policies, err = st.ListRetentionPolicies(ctx)
	if err != nil {
		t.Fatalf("ListRetentionPolicies: %v", err)
	}
	if len(policies) != 1 || policies[0].WorkspaceID != ws.ID || policies[0].RetentionDays != 30 {
		t.Fatalf("ListRetentionPolicies = %+v, want only ws %d with 30d", policies, ws.ID)
	}

	now := time.Now().UTC()
	oldTime := now.Add(-60 * 24 * time.Hour)
	freshTime := now.Add(-5 * 24 * time.Hour)
	cutoff := now.Add(-30 * 24 * time.Hour)

	// Append expired + fresh audit logs in ws, plus an expired log in otherWS.
	for _, entry := range []store.AuditLogEntry{
		{WorkspaceID: ws.ID, ActorID: owner.ID, Action: "doc.create", ResourceTitle: "Old Log 1", CreatedAt: oldTime},
		{WorkspaceID: ws.ID, ActorID: owner.ID, Action: "doc.update", ResourceTitle: "Old Log 2", CreatedAt: oldTime.Add(time.Hour)},
		{WorkspaceID: ws.ID, ActorID: owner.ID, Action: "doc.create", ResourceTitle: "Fresh Log", CreatedAt: freshTime},
		{WorkspaceID: otherWS.ID, ActorID: outsider.ID, Action: "doc.create", ResourceTitle: "Other WS Old Log", CreatedAt: oldTime},
	} {
		if err := st.AppendAuditLog(ctx, entry); err != nil {
			t.Fatalf("AppendAuditLog: %v", err)
		}
	}

	// Create docs in ws: active doc, fresh trashed doc, expired trashed folder + child doc; plus expired trashed doc in otherWS.
	activeDoc, err := st.CreateDriveNode(ctx, ownerGuard, ws.ID, nil, "doc", "Active Doc", false)
	if err != nil {
		t.Fatalf("create active doc: %v", err)
	}
	freshTrashedDoc, err := st.CreateDriveNode(ctx, ownerGuard, ws.ID, nil, "doc", "Fresh Trashed", false)
	if err != nil {
		t.Fatalf("create fresh trashed doc: %v", err)
	}
	expiredFolder, err := st.CreateDriveFolder(ctx, ownerGuard, ws.ID, nil, "Expired Folder", false)
	if err != nil {
		t.Fatalf("create expired folder: %v", err)
	}
	expiredChildDoc, err := st.CreateDriveNode(ctx, ownerGuard, ws.ID, &expiredFolder.ID, "doc", "Expired Child", false)
	if err != nil {
		t.Fatalf("create expired child doc: %v", err)
	}
	otherExpiredDoc, err := st.CreateDriveNode(ctx, outsiderGuard, otherWS.ID, nil, "doc", "Other WS Expired Trash", false)
	if err != nil {
		t.Fatalf("create otherWS doc: %v", err)
	}

	if err := st.TrashDriveNode(ctx, ownerGuard, freshTrashedDoc.ID, freshTrashedDoc.Revision); err != nil {
		t.Fatalf("trash fresh doc: %v", err)
	}
	if err := st.TrashDriveNode(ctx, ownerGuard, expiredFolder.ID, expiredFolder.Revision); err != nil {
		t.Fatalf("trash expired folder: %v", err)
	}
	if err := st.TrashDriveNode(ctx, outsiderGuard, otherExpiredDoc.ID, otherExpiredDoc.Revision); err != nil {
		t.Fatalf("trash otherWS doc: %v", err)
	}

	// Backdate deletion timestamps for the expired nodes.
	setDeletedAt := func(nodeID int64, at time.Time) {
		t.Helper()
		switch impl := st.(type) {
		case *store.Memory:
			impl.SetMemoryNodeDeletedAt(nodeID, at)
		case *store.Postgres:
			if _, err := impl.Pool.Exec(ctx, `UPDATE nodes SET deleted_at = $2, drive_revision = drive_revision + 1 WHERE id = $1`, nodeID, at); err != nil {
				t.Fatalf("backdate node %d deleted_at: %v", nodeID, err)
			}
		}
	}
	setDeletedAt(expiredFolder.ID, oldTime)
	setDeletedAt(expiredChildDoc.ID, oldTime)
	setDeletedAt(otherExpiredDoc.ID, oldTime)
	setDeletedAt(freshTrashedDoc.ID, freshTime)

	// Run retention purge ONLY for ws.ID.
	purgedLogs, purgedNodes, err := st.PurgeExpiredRetentionData(ctx, ws.ID, cutoff)
	if err != nil {
		t.Fatalf("PurgeExpiredRetentionData: %v", err)
	}
	if purgedLogs != 2 {
		t.Fatalf("purgedLogs = %d, want 2", purgedLogs)
	}
	if purgedNodes != 2 {
		t.Fatalf("purgedNodes = %d, want 2 (expired folder + child)", purgedNodes)
	}

	// Verify ws audit logs: only Fresh Log remains.
	wsLogs, err := st.ListAuditLogsGuarded(ctx, ownerGuard, ws.ID, store.AuditLogFilter{})
	if err != nil {
		t.Fatalf("list ws audit logs: %v", err)
	}
	if wsLogs.Total != 1 || wsLogs.Items[0].ResourceTitle != "Fresh Log" {
		t.Fatalf("remaining ws logs = %+v, want only Fresh Log", wsLogs)
	}

	// Verify otherWS expired log & trash node are untouched!
	otherLogs, err := st.ListAuditLogsGuarded(ctx, outsiderGuard, otherWS.ID, store.AuditLogFilter{})
	if err != nil || otherLogs.Total != 1 {
		t.Fatalf("otherWS logs = %+v err=%v, want 1 untouched", otherLogs, err)
	}
	otherTrash, err := st.ListTrash(ctx, outsider.ID)
	if err != nil || len(otherTrash) != 1 || otherTrash[0].ID != otherExpiredDoc.ID {
		t.Fatalf("otherWS trash = %+v err=%v, want untouched doc %d", otherTrash, err, otherExpiredDoc.ID)
	}

	// Verify ws trash: only Fresh Trashed remains; active doc still exists.
	wsTrash, err := st.ListTrash(ctx, owner.ID)
	if err != nil {
		t.Fatalf("ListTrash: %v", err)
	}
	if len(wsTrash) != 1 || wsTrash[0].ID != freshTrashedDoc.ID {
		t.Fatalf("ws trash after purge = %+v, want only fresh doc %d", wsTrash, freshTrashedDoc.ID)
	}
	if _, err := st.GetDoc(ctx, owner.ID, activeDoc.ID); err != nil {
		t.Fatalf("active doc should remain accessible, got err=%v", err)
	}

	// Re-running purge immediately is a no-op (0 logs, 0 nodes).
	purgedLogs2, purgedNodes2, err := st.PurgeExpiredRetentionData(ctx, ws.ID, cutoff)
	if err != nil || purgedLogs2 != 0 || purgedNodes2 != 0 {
		t.Fatalf("second purge = (%d, %d, %v), want (0, 0, nil)", purgedLogs2, purgedNodes2, err)
	}
}

func TestAuditLogMemory(t *testing.T) {
	exerciseAuditLogs(t, store.NewMemory())
}

func TestWorkspaceSecurityPolicyMemory(t *testing.T) {
	exerciseWorkspaceSecurityPolicy(t, store.NewMemory())
}

func TestRetentionPurgeMemory(t *testing.T) {
	exerciseRetentionPurge(t, store.NewMemory())
}

func TestAuditLogAndPolicyPostgres(t *testing.T) {
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
	t.Run("AuditLogs", func(t *testing.T) { exerciseAuditLogs(t, pg) })
	if _, err := pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	t.Run("WorkspaceSecurityPolicy", func(t *testing.T) { exerciseWorkspaceSecurityPolicy(t, pg) })
	if _, err := pg.Pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := migrate.Up(ctx, pg.Pool); err != nil {
		t.Fatal(err)
	}
	t.Run("RetentionPurge", func(t *testing.T) { exerciseRetentionPurge(t, pg) })
}
