package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/migrate"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func exerciseSSOStore(t *testing.T, st interface {
	store.Store
	store.SSOStore
}) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().Truncate(time.Second)
	exp := now.Add(time.Hour)

	owner, ws, err := st.CreateUser(ctx, "sso-owner@example.test", "Owner", "hash")
	if err != nil {
		t.Fatal(err)
	}
	adminUser, _, err := st.CreateUser(ctx, "sso-admin@example.test", "Admin", "hash")
	if err != nil {
		t.Fatal(err)
	}
	memberUser, _, err := st.CreateUser(ctx, "sso-member@example.test", "Member", "hash")
	if err != nil {
		t.Fatal(err)
	}
	outsider, otherWS, err := st.CreateUser(ctx, "sso-outsider@example.test", "Outsider", "hash")
	if err != nil {
		t.Fatal(err)
	}

	makeGuard := func(u store.User, tag string) store.RestoreGuard {
		g := store.RestoreGuard{UserID: u.ID, SessionHash: []byte("sso-sess-" + tag), Now: func() time.Time { return now }}
		if err := st.CreateSession(ctx, g.SessionHash, u.ID, exp); err != nil {
			t.Fatal(err)
		}
		return g
	}
	ownerGuard := makeGuard(owner, "owner")
	adminGuard := makeGuard(adminUser, "admin")
	memberGuard := makeGuard(memberUser, "member")
	outsiderGuard := makeGuard(outsider, "outsider")

	// Add adminUser as workspace admin and memberUser as workspace member.
	if err := st.AddWorkspaceMember(ctx, ws.ID, adminUser.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertWorkspaceMemberGuarded(ctx, ownerGuard, ws.ID, adminUser.Email, store.WorkspaceRoleAdmin); err != nil {
		t.Fatal(err)
	}
	if err := st.AddWorkspaceMember(ctx, ws.ID, memberUser.ID); err != nil {
		t.Fatal(err)
	}

	validInput := store.SSOProviderInput{
		Slug:            "corp-oidc",
		Name:            "Corp Okta",
		ProviderType:    store.SSOProviderOIDC,
		Enabled:         true,
		IssuerURL:       "https://idp.example.com/",
		AuthURL:         "https://idp.example.com/oauth2/authorize",
		TokenURL:        "https://idp.example.com/oauth2/token",
		UserinfoURL:     "https://idp.example.com/oauth2/userinfo",
		ClientID:        "client-123",
		ClientSecretEnc: []byte("encrypted-secret-bytes"),
		SecretHint:      "9876",
		Scopes:          "openid email profile",
		AutoCreateUser:  true,
		DefaultRole:     store.WorkspaceRoleMember,
		AllowedDomains:  " Example.com, @Corp.Example.com , example.com ",
	}

	// Non-admin member & outsider cannot list or create providers.
	if _, err := st.ListWorkspaceSSOProviders(ctx, memberGuard, ws.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member ListWorkspaceSSOProviders = %v, want ErrForbidden", err)
	}
	if _, err := st.CreateSSOProviderGuarded(ctx, memberGuard, ws.ID, validInput); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member CreateSSOProviderGuarded = %v, want ErrForbidden", err)
	}
	if _, err := st.CreateSSOProviderGuarded(ctx, outsiderGuard, ws.ID, validInput); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("outsider CreateSSOProviderGuarded = %v, want ErrForbidden", err)
	}

	// Validation checks: invalid slug, providerType, URL, defaultRole.
	badCases := []struct {
		name string
		mut  func(*store.SSOProviderInput)
	}{
		{"short slug", func(in *store.SSOProviderInput) { in.Slug = "a" }},
		{"bad slug chars", func(in *store.SSOProviderInput) { in.Slug = "bad slug!" }},
		{"slug starts with dash", func(in *store.SSOProviderInput) { in.Slug = "-corp" }},
		{"bad provider type", func(in *store.SSOProviderInput) { in.ProviderType = "saml" }},
		{"missing auth url", func(in *store.SSOProviderInput) { in.AuthURL = "" }},
		{"bad token url scheme", func(in *store.SSOProviderInput) { in.TokenURL = "ftp://idp.example.com/token" }},
		{"owner default role", func(in *store.SSOProviderInput) { in.DefaultRole = store.WorkspaceRoleOwner }},
		{"empty client id", func(in *store.SSOProviderInput) { in.ClientID = "  " }},
	}
	for _, tc := range badCases {
		in := validInput
		tc.mut(&in)
		if _, err := st.CreateSSOProviderGuarded(ctx, ownerGuard, ws.ID, in); !errors.Is(err, store.ErrConflict) {
			t.Fatalf("case %s: got %v, want ErrConflict", tc.name, err)
		}
	}

	// Owner creates first provider.
	p1, err := st.CreateSSOProviderGuarded(ctx, ownerGuard, ws.ID, validInput)
	if err != nil {
		t.Fatalf("create p1: %v", err)
	}
	if p1.ID <= 0 || p1.Slug != "corp-oidc" || !p1.HasClientSecret || p1.SecretHint != "9876" {
		t.Fatalf("unexpected p1: %+v", p1)
	}
	if p1.IssuerURL != "https://idp.example.com" {
		t.Fatalf("issuerUrl trailing slash not trimmed: %q", p1.IssuerURL)
	}
	if p1.AllowedDomains != "example.com,corp.example.com" {
		t.Fatalf("allowedDomains = %q", p1.AllowedDomains)
	}

	// JSON marshaling MUST never expose ClientSecretEnc.
	bySlug, err := st.GetSSOProviderBySlug(ctx, "CORP-OIDC")
	if err != nil {
		t.Fatalf("GetSSOProviderBySlug: %v", err)
	}
	if string(bySlug.ClientSecretEnc) != "encrypted-secret-bytes" || !bySlug.HasClientSecret {
		t.Fatalf("GetSSOProviderBySlug secret missing: %+v", bySlug)
	}
	rawJSON, err := json.Marshal(bySlug)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rawJSON), "encrypted-secret-bytes") || strings.Contains(string(rawJSON), "ClientSecretEnc") {
		t.Fatalf("SSOProvider JSON leaked ClientSecretEnc: %s", rawJSON)
	}

	// Duplicate slug rejected with ErrConflict (even in another workspace).
	if _, err := st.CreateSSOProviderGuarded(ctx, outsiderGuard, otherWS.ID, validInput); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("duplicate slug across workspaces = %v, want ErrConflict", err)
	}

	// Workspace admin can also create a second (disabled) provider.
	p2Input := validInput
	p2Input.Slug = "feishu-sso"
	p2Input.Name = "Feishu Enterprise"
	p2Input.ProviderType = store.SSOProviderFeishu
	p2Input.Enabled = false
	p2Input.ClientSecretEnc = nil
	p2Input.SecretHint = ""
	p2, err := st.CreateSSOProviderGuarded(ctx, adminGuard, ws.ID, p2Input)
	if err != nil {
		t.Fatalf("admin create p2: %v", err)
	}
	if p2.HasClientSecret {
		t.Fatalf("p2 should not report HasClientSecret")
	}

	// ListPublicSSOProviders returns ONLY enabled providers ordered by id ASC with no secrets/clientId.
	pub, err := st.ListPublicSSOProviders(ctx)
	if err != nil {
		t.Fatalf("ListPublicSSOProviders: %v", err)
	}
	if len(pub) != 1 || pub[0].ID != p1.ID || pub[0].Slug != "corp-oidc" || pub[0].Name != "Corp Okta" || pub[0].ProviderType != "oidc" {
		t.Fatalf("unexpected public providers: %+v", pub)
	}
	pubJSON, _ := json.Marshal(pub)
	if strings.Contains(string(pubJSON), "client-123") || strings.Contains(string(pubJSON), "9876") {
		t.Fatalf("public providers leaked clientId/secretHint: %s", pubJSON)
	}

	// ListWorkspaceSSOProviders returns both providers for admin.
	wsProviders, err := st.ListWorkspaceSSOProviders(ctx, adminGuard, ws.ID)
	if err != nil || len(wsProviders) != 2 || wsProviders[0].ID != p1.ID || wsProviders[1].ID != p2.ID {
		t.Fatalf("ListWorkspaceSSOProviders = %+v err=%v", wsProviders, err)
	}

	// Update p2: enable + rotate secret; verify p1 keeps its secret on non-secret update.
	enabledTrue := true
	newName := "Corp Okta v2"
	p1Updated, err := st.UpdateSSOProviderGuarded(ctx, ownerGuard, ws.ID, p1.ID, store.SSOProviderPatch{
		Name: &newName,
	})
	if err != nil || p1Updated.Name != "Corp Okta v2" || !p1Updated.HasClientSecret || p1Updated.SecretHint != "9876" {
		t.Fatalf("update p1 = %+v err=%v", p1Updated, err)
	}
	p1Fetched, err := st.GetSSOProviderBySlug(ctx, p1.Slug)
	if err != nil || string(p1Fetched.ClientSecretEnc) != "encrypted-secret-bytes" {
		t.Fatalf("p1 secret lost after non-secret update: %+v err=%v", p1Fetched, err)
	}

	p2Updated, err := st.UpdateSSOProviderGuarded(ctx, adminGuard, ws.ID, p2.ID, store.SSOProviderPatch{
		Enabled:         &enabledTrue,
		ClientSecretEnc: []byte("feishu-secret-enc"),
		SecretHint:      "4321",
		UpdateSecret:    true,
	})
	if err != nil || !p2Updated.Enabled || !p2Updated.HasClientSecret || p2Updated.SecretHint != "4321" {
		t.Fatalf("update p2 = %+v err=%v", p2Updated, err)
	}
	pub, err = st.ListPublicSSOProviders(ctx)
	if err != nil || len(pub) != 2 || pub[0].ID != p1.ID || pub[1].ID != p2.ID {
		t.Fatalf("public providers after enabling p2 = %+v err=%v", pub, err)
	}

	// Cross-workspace update/delete returns ErrNotFound.
	if _, err := st.UpdateSSOProviderGuarded(ctx, outsiderGuard, otherWS.ID, p1.ID, store.SSOProviderPatch{Name: &newName}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-ws update = %v, want ErrNotFound", err)
	}
	if err := st.DeleteSSOProviderGuarded(ctx, outsiderGuard, otherWS.ID, p1.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-ws delete = %v, want ErrNotFound", err)
	}

	// Auth state: create, atomic single-use consume, replay rejected, expiry rejected.
	st1 := store.SSOAuthState{
		State:        "state-valid-1",
		ProviderID:   p1.ID,
		CodeVerifier: "verifier-abc",
		Nonce:        "nonce-xyz",
		RedirectTo:   "/#/docs/42",
		ExpiresAt:    now.Add(10 * time.Minute),
	}
	if err := st.CreateSSOAuthState(ctx, st1); err != nil {
		t.Fatalf("CreateSSOAuthState: %v", err)
	}
	gotState, err := st.ConsumeSSOAuthState(ctx, "state-valid-1", now.Add(5*time.Minute))
	if err != nil || gotState.ProviderID != p1.ID || gotState.CodeVerifier != "verifier-abc" || gotState.Nonce != "nonce-xyz" || gotState.RedirectTo != "/#/docs/42" {
		t.Fatalf("ConsumeSSOAuthState = %+v err=%v", gotState, err)
	}
	// Replay must fail with ErrNotFound.
	if _, err := st.ConsumeSSOAuthState(ctx, "state-valid-1", now.Add(5*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("replayed state = %v, want ErrNotFound", err)
	}
	// Expired state must fail with ErrNotFound (and be deleted).
	stExp := st1
	stExp.State = "state-expired-1"
	if err := st.CreateSSOAuthState(ctx, stExp); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ConsumeSSOAuthState(ctx, "state-expired-1", now.Add(10*time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired state = %v, want ErrNotFound", err)
	}

	// ResolveOrProvisionSSOUser:
	// 1) Existing user matched by case-insensitive email -> linked & added to workspace with defaultRole.
	existingNonMember, _, err := st.CreateUser(ctx, "Existing.User@Example.com", "Existing", "hash")
	if err != nil {
		t.Fatal(err)
	}
	resolvedExisting, err := st.ResolveOrProvisionSSOUser(ctx, p1.ID, ws.ID, "sub-existing-1", "existing.user@example.com", "Ignored Name", false, store.WorkspaceRoleAdmin)
	if err != nil || resolvedExisting.ID != existingNonMember.ID {
		t.Fatalf("email-matched user = %+v err=%v, want ID=%d", resolvedExisting, err, existingNonMember.ID)
	}
	// Verify added to ws with admin role.
	orgSnap, err := st.GetWorkspaceOrg(ctx, ownerGuard, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	foundRole := ""
	for _, m := range orgSnap.Members {
		if m.UserID == existingNonMember.ID {
			foundRole = m.Role
		}
	}
	if foundRole != store.WorkspaceRoleAdmin {
		t.Fatalf("email-matched user workspace role = %q, want admin", foundRole)
	}

	// 2) Subsequent login by same (provider_id, subject) resolves same user even if email changed,
	//    and does not downgrade existing workspace role.
	resolvedBySubject, err := st.ResolveOrProvisionSSOUser(ctx, p1.ID, ws.ID, "sub-existing-1", "renamed@example.com", "Renamed", false, store.WorkspaceRoleMember)
	if err != nil || resolvedBySubject.ID != existingNonMember.ID {
		t.Fatalf("subject-matched user = %+v err=%v, want ID=%d", resolvedBySubject, err, existingNonMember.ID)
	}
	orgSnap, _ = st.GetWorkspaceOrg(ctx, ownerGuard, ws.ID)
	for _, m := range orgSnap.Members {
		if m.UserID == existingNonMember.ID && m.Role != store.WorkspaceRoleAdmin {
			t.Fatalf("existing admin role was overwritten to %q", m.Role)
		}
	}

	// 3) Unknown user with autoCreate=false -> ErrForbidden.
	if _, err := st.ResolveOrProvisionSSOUser(ctx, p1.ID, ws.ID, "sub-blocked", "blocked@example.com", "Blocked", false, store.WorkspaceRoleMember); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("autoCreate=false got %v, want ErrForbidden", err)
	}

	// 4) Unknown user with autoCreate=true -> JIT provisions user + personal workspace + joins target workspace.
	jitUser, err := st.ResolveOrProvisionSSOUser(ctx, p1.ID, ws.ID, "sub-jit-1", "NewHire@Example.com", "New Hire", true, store.WorkspaceRoleMember)
	if err != nil {
		t.Fatalf("JIT provision failed: %v", err)
	}
	if jitUser.ID <= 0 || jitUser.Email != "newhire@example.com" || jitUser.Name != "New Hire" || jitUser.PasswordHash == "" {
		t.Fatalf("unexpected JIT user: %+v", jitUser)
	}
	jitWorkspaces, err := st.Workspaces(ctx, jitUser.ID)
	if err != nil {
		t.Fatal(err)
	}
	hasPersonal := false
	hasTarget := false
	for _, w := range jitWorkspaces {
		if w.OwnerID == jitUser.ID {
			hasPersonal = true
		}
		if w.ID == ws.ID {
			hasTarget = true
		}
	}
	if !hasPersonal || !hasTarget {
		t.Fatalf("JIT user workspaces = %+v, want both personal and target ws %d", jitWorkspaces, ws.ID)
	}

	// Delete p2 and verify removal.
	if err := st.DeleteSSOProviderGuarded(ctx, memberGuard, ws.ID, p2.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("member delete = %v, want ErrForbidden", err)
	}
	if err := st.DeleteSSOProviderGuarded(ctx, ownerGuard, ws.ID, p2.ID); err != nil {
		t.Fatalf("owner delete p2: %v", err)
	}
	if _, err := st.GetSSOProviderBySlug(ctx, p2.Slug); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted p2 still found: %v", err)
	}
}

func TestSSOMemory(t *testing.T) {
	exerciseSSOStore(t, store.NewMemory())
}

func TestSSOPostgres(t *testing.T) {
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
	exerciseSSOStore(t, pg)
}
