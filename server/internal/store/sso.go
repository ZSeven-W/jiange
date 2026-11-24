package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	SSOProviderOIDC     = "oidc"
	SSOProviderOAuth2   = "oauth2"
	SSOProviderFeishu   = "feishu"
	SSOProviderWeCom    = "wecom"
	SSOProviderDingTalk = "dingtalk"
	SSOProviderGitHub   = "github"
	SSOProviderGoogle   = "google"

	DefaultSSOScopes = "openid email profile"
)

var reSSOSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,39}$`)

// SSOProvider configures an enterprise OIDC/OAuth2 identity provider bound to a workspace.
type SSOProvider struct {
	ID              int64     `json:"id"`
	WorkspaceID     int64     `json:"workspaceId"`
	Slug            string    `json:"slug"`
	Name            string    `json:"name"`
	ProviderType    string    `json:"providerType"`
	Enabled         bool      `json:"enabled"`
	IssuerURL       string    `json:"issuerUrl"`
	AuthURL         string    `json:"authUrl"`
	TokenURL        string    `json:"tokenUrl"`
	UserinfoURL     string    `json:"userinfoUrl"`
	ClientID        string    `json:"clientId"`
	ClientSecretEnc []byte    `json:"-"`
	HasClientSecret bool      `json:"hasClientSecret"`
	SecretHint      string    `json:"secretHint"`
	Scopes          string    `json:"scopes"`
	AutoCreateUser  bool      `json:"autoCreateUser"`
	DefaultRole     string    `json:"defaultRole"`
	AllowedDomains  string    `json:"allowedDomains"`
	CreatedBy       *int64    `json:"createdBy,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

// PublicSSOProvider is the unauthenticated login-page projection of an enabled SSO provider.
// It intentionally excludes clientId, endpoint URLs, and all secret metadata.
type PublicSSOProvider struct {
	ID           int64  `json:"id"`
	Slug         string `json:"slug"`
	Name         string `json:"name"`
	ProviderType string `json:"providerType"`
}

// SSOProviderInput creates a new workspace SSO provider.
type SSOProviderInput struct {
	Slug            string
	Name            string
	ProviderType    string
	Enabled         bool
	IssuerURL       string
	AuthURL         string
	TokenURL        string
	UserinfoURL     string
	ClientID        string
	ClientSecretEnc []byte
	SecretHint      string
	Scopes          string
	AutoCreateUser  bool
	DefaultRole     string
	AllowedDomains  string
}

// SSOProviderPatch partially updates a workspace SSO provider.
type SSOProviderPatch struct {
	Slug            *string
	Name            *string
	ProviderType    *string
	Enabled         *bool
	IssuerURL       *string
	AuthURL         *string
	TokenURL        *string
	UserinfoURL     *string
	ClientID        *string
	ClientSecretEnc []byte
	SecretHint      string
	UpdateSecret    bool
	Scopes          *string
	AutoCreateUser  *bool
	DefaultRole     *string
	AllowedDomains  *string
}

// SSOAuthState stores a short-lived, single-use PKCE + CSRF + nonce state.
type SSOAuthState struct {
	State        string
	ProviderID   int64
	CodeVerifier string
	Nonce        string
	RedirectTo   string
	ExpiresAt    time.Time
}

// SSOIdentity links an external IdP subject to a local Jiange user.
type SSOIdentity struct {
	ProviderID  int64     `json:"providerId"`
	Subject     string    `json:"subject"`
	UserID      int64     `json:"userId"`
	Email       string    `json:"email"`
	CreatedAt   time.Time `json:"createdAt"`
	LastLoginAt time.Time `json:"lastLoginAt"`
}

// SSOStore manages enterprise OIDC/OAuth2 SSO providers, ephemeral PKCE auth states,
// and identity linking / JIT user provisioning.
type SSOStore interface {
	ListPublicSSOProviders(ctx context.Context) ([]PublicSSOProvider, error)
	GetSSOProviderBySlug(ctx context.Context, slug string) (SSOProvider, error)
	ListWorkspaceSSOProviders(ctx context.Context, guard RestoreGuard, wsID int64) ([]SSOProvider, error)
	CreateSSOProviderGuarded(ctx context.Context, guard RestoreGuard, wsID int64, in SSOProviderInput) (SSOProvider, error)
	UpdateSSOProviderGuarded(ctx context.Context, guard RestoreGuard, wsID, providerID int64, patch SSOProviderPatch) (SSOProvider, error)
	DeleteSSOProviderGuarded(ctx context.Context, guard RestoreGuard, wsID, providerID int64) error
	CreateSSOAuthState(ctx context.Context, st SSOAuthState) error
	ConsumeSSOAuthState(ctx context.Context, state string, now time.Time) (SSOAuthState, error)
	ResolveOrProvisionSSOUser(ctx context.Context, providerID, workspaceID int64, subject, email, name string, autoCreate bool, defaultRole string) (User, error)
}

var (
	_ SSOStore = (*Memory)(nil)
	_ SSOStore = (*Postgres)(nil)
)

// ValidSSOSlug reports whether slug matches the allowed URL-safe identifier format.
func ValidSSOSlug(slug string) bool {
	return reSSOSlug.MatchString(slug)
}

// ValidSSOProviderType reports whether t is a supported SSO provider type.
func ValidSSOProviderType(t string) bool {
	switch t {
	case SSOProviderOIDC, SSOProviderOAuth2, SSOProviderFeishu, SSOProviderWeCom,
		SSOProviderDingTalk, SSOProviderGitHub, SSOProviderGoogle:
		return true
	default:
		return false
	}
}

// ValidSSODefaultRole reports whether role is a valid JIT workspace member role.
func ValidSSODefaultRole(role string) bool {
	return role == WorkspaceRoleMember || role == WorkspaceRoleAdmin
}

// ValidSSOURL validates an HTTP(S) URL with a non-empty host and no embedded credentials.
func ValidSSOURL(raw string, required bool) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", !required
	}
	if len(trimmed) > 1024 {
		return "", false
	}
	u, err := url.Parse(trimmed)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
		return "", false
	}
	return u.String(), true
}

// NormalizeSSOAllowedDomains cleans and deduplicates a comma/whitespace-separated domain allowlist.
func NormalizeSSOAllowedDomains(raw string) string {
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\t' || r == '\n' || r == '\r'
	})
	seen := make(map[string]bool, len(parts))
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		d := strings.ToLower(strings.TrimSpace(p))
		d = strings.TrimPrefix(d, "@")
		d = strings.TrimPrefix(d, ".")
		if d == "" || strings.ContainsAny(d, "/:@\\") || !strings.Contains(d, ".") {
			continue
		}
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	return strings.Join(out, ",")
}

func validateSSOProviderFields(p *SSOProvider) error {
	p.Slug = strings.ToLower(strings.TrimSpace(p.Slug))
	if !ValidSSOSlug(p.Slug) {
		return ErrConflict
	}
	p.Name = strings.TrimSpace(p.Name)
	if n := utf8.RuneCountInString(p.Name); n < 1 || n > 120 {
		return ErrConflict
	}
	p.ProviderType = strings.ToLower(strings.TrimSpace(p.ProviderType))
	if p.ProviderType == "" {
		p.ProviderType = SSOProviderOIDC
	}
	if !ValidSSOProviderType(p.ProviderType) {
		return ErrConflict
	}
	issuer, ok := ValidSSOURL(p.IssuerURL, false)
	if !ok {
		return ErrConflict
	}
	p.IssuerURL = strings.TrimRight(issuer, "/")
	authURL, ok := ValidSSOURL(p.AuthURL, true)
	if !ok {
		return ErrConflict
	}
	p.AuthURL = authURL
	tokenURL, ok := ValidSSOURL(p.TokenURL, true)
	if !ok {
		return ErrConflict
	}
	p.TokenURL = tokenURL
	userinfoURL, ok := ValidSSOURL(p.UserinfoURL, false)
	if !ok {
		return ErrConflict
	}
	p.UserinfoURL = userinfoURL
	p.ClientID = strings.TrimSpace(p.ClientID)
	if p.ClientID == "" || len(p.ClientID) > 256 {
		return ErrConflict
	}
	p.Scopes = strings.TrimSpace(p.Scopes)
	if p.Scopes == "" {
		p.Scopes = DefaultSSOScopes
	}
	if len(p.Scopes) > 512 {
		return ErrConflict
	}
	p.DefaultRole = strings.ToLower(strings.TrimSpace(p.DefaultRole))
	if p.DefaultRole == "" {
		p.DefaultRole = WorkspaceRoleMember
	}
	if !ValidSSODefaultRole(p.DefaultRole) {
		return ErrConflict
	}
	p.AllowedDomains = NormalizeSSOAllowedDomains(p.AllowedDomains)
	p.SecretHint = strings.TrimSpace(p.SecretHint)
	if len(p.SecretHint) > 32 {
		p.SecretHint = p.SecretHint[:32]
	}
	p.HasClientSecret = len(p.ClientSecretEnc) > 0
	return nil
}

func cloneSSOProvider(p SSOProvider, includeSecret bool) SSOProvider {
	p.HasClientSecret = len(p.ClientSecretEnc) > 0
	if includeSecret && len(p.ClientSecretEnc) > 0 {
		cp := make([]byte, len(p.ClientSecretEnc))
		copy(cp, p.ClientSecretEnc)
		p.ClientSecretEnc = cp
	} else {
		p.ClientSecretEnc = nil
	}
	if p.CreatedBy != nil {
		v := *p.CreatedBy
		p.CreatedBy = &v
	}
	return p
}

func randomSSOPasswordHash() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "sso$" + hex.EncodeToString(b), nil
}

func normalizeSSODisplayName(name, email string) string {
	n := strings.TrimSpace(name)
	if n == "" && email != "" {
		if at := strings.IndexByte(email, '@'); at > 0 {
			n = email[:at]
		}
	}
	if n == "" {
		n = "SSO User"
	}
	if runes := []rune(n); len(runes) > 64 {
		n = string(runes[:64])
	}
	return n
}

func syntheticSSOEmail(providerID int64, subject string) string {
	sum := sha256.Sum256([]byte(subject))
	return fmt.Sprintf("sso-%d-%s@sso.local", providerID, hex.EncodeToString(sum[:8]))
}

func normalizeSSODefaultRole(role string) string {
	if strings.EqualFold(strings.TrimSpace(role), WorkspaceRoleAdmin) {
		return WorkspaceRoleAdmin
	}
	return WorkspaceRoleMember
}

// --- Memory implementation ---

type ssoIdentityKey struct {
	providerID int64
	subject    string
}

// memSSO holds in-memory OIDC/OAuth2 SSO state for Memory store.
type memSSO struct {
	nextProviderID int64
	providers      map[int64]SSOProvider
	identities     map[ssoIdentityKey]SSOIdentity
	states         map[string]SSOAuthState
}

func (m *Memory) initSSOLocked() {
	if m.sso.providers == nil {
		m.sso.providers = map[int64]SSOProvider{}
	}
	if m.sso.identities == nil {
		m.sso.identities = map[ssoIdentityKey]SSOIdentity{}
	}
	if m.sso.states == nil {
		m.sso.states = map[string]SSOAuthState{}
	}
}

func (m *Memory) ListPublicSSOProviders(_ context.Context) ([]PublicSSOProvider, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]PublicSSOProvider, 0)
	for _, p := range m.sso.providers {
		if !p.Enabled {
			continue
		}
		out = append(out, PublicSSOProvider{
			ID:           p.ID,
			Slug:         p.Slug,
			Name:         p.Name,
			ProviderType: p.ProviderType,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *Memory) GetSSOProviderBySlug(_ context.Context, slug string) (SSOProvider, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	target := strings.ToLower(strings.TrimSpace(slug))
	for _, p := range m.sso.providers {
		if p.Slug == target {
			return cloneSSOProvider(p, true), nil
		}
	}
	return SSOProvider{}, ErrNotFound
}

func (m *Memory) ListWorkspaceSSOProviders(ctx context.Context, guard RestoreGuard, wsID int64) ([]SSOProvider, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return nil, err
	}
	out := make([]SSOProvider, 0)
	for _, p := range m.sso.providers {
		if p.WorkspaceID == wsID {
			out = append(out, cloneSSOProvider(p, false))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return nil, err
	}
	return out, nil
}

func (m *Memory) CreateSSOProviderGuarded(ctx context.Context, guard RestoreGuard, wsID int64, in SSOProviderInput) (SSOProvider, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return SSOProvider{}, err
	}
	m.initSSOLocked()

	now := guard.currentTime()
	createdBy := guard.UserID
	p := SSOProvider{
		WorkspaceID:     wsID,
		Slug:            in.Slug,
		Name:            in.Name,
		ProviderType:    in.ProviderType,
		Enabled:         in.Enabled,
		IssuerURL:       in.IssuerURL,
		AuthURL:         in.AuthURL,
		TokenURL:        in.TokenURL,
		UserinfoURL:     in.UserinfoURL,
		ClientID:        in.ClientID,
		ClientSecretEnc: append([]byte(nil), in.ClientSecretEnc...),
		SecretHint:      in.SecretHint,
		Scopes:          in.Scopes,
		AutoCreateUser:  in.AutoCreateUser,
		DefaultRole:     in.DefaultRole,
		AllowedDomains:  in.AllowedDomains,
		CreatedBy:       &createdBy,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := validateSSOProviderFields(&p); err != nil {
		return SSOProvider{}, err
	}
	for _, existing := range m.sso.providers {
		if existing.Slug == p.Slug {
			return SSOProvider{}, ErrConflict
		}
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return SSOProvider{}, err
	}
	m.sso.nextProviderID++
	p.ID = m.sso.nextProviderID
	m.sso.providers[p.ID] = p
	return cloneSSOProvider(p, false), nil
}

func (m *Memory) UpdateSSOProviderGuarded(ctx context.Context, guard RestoreGuard, wsID, providerID int64, patch SSOProviderPatch) (SSOProvider, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return SSOProvider{}, err
	}
	cur, ok := m.sso.providers[providerID]
	if !ok || cur.WorkspaceID != wsID {
		return SSOProvider{}, ErrNotFound
	}
	next := cloneSSOProvider(cur, true)
	if patch.Slug != nil {
		next.Slug = *patch.Slug
	}
	if patch.Name != nil {
		next.Name = *patch.Name
	}
	if patch.ProviderType != nil {
		next.ProviderType = *patch.ProviderType
	}
	if patch.Enabled != nil {
		next.Enabled = *patch.Enabled
	}
	if patch.IssuerURL != nil {
		next.IssuerURL = *patch.IssuerURL
	}
	if patch.AuthURL != nil {
		next.AuthURL = *patch.AuthURL
	}
	if patch.TokenURL != nil {
		next.TokenURL = *patch.TokenURL
	}
	if patch.UserinfoURL != nil {
		next.UserinfoURL = *patch.UserinfoURL
	}
	if patch.ClientID != nil {
		next.ClientID = *patch.ClientID
	}
	if patch.UpdateSecret {
		next.ClientSecretEnc = append([]byte(nil), patch.ClientSecretEnc...)
		next.SecretHint = patch.SecretHint
	}
	if patch.Scopes != nil {
		next.Scopes = *patch.Scopes
	}
	if patch.AutoCreateUser != nil {
		next.AutoCreateUser = *patch.AutoCreateUser
	}
	if patch.DefaultRole != nil {
		next.DefaultRole = *patch.DefaultRole
	}
	if patch.AllowedDomains != nil {
		next.AllowedDomains = *patch.AllowedDomains
	}
	next.UpdatedAt = guard.currentTime()
	if err := validateSSOProviderFields(&next); err != nil {
		return SSOProvider{}, err
	}
	for id, existing := range m.sso.providers {
		if id != providerID && existing.Slug == next.Slug {
			return SSOProvider{}, ErrConflict
		}
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return SSOProvider{}, err
	}
	m.sso.providers[providerID] = next
	return cloneSSOProvider(next, false), nil
}

func (m *Memory) DeleteSSOProviderGuarded(ctx context.Context, guard RestoreGuard, wsID, providerID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, err := m.checkWorkspaceAdminLocked(ctx, guard, wsID)
	if err != nil {
		return err
	}
	cur, ok := m.sso.providers[providerID]
	if !ok || cur.WorkspaceID != wsID {
		return ErrNotFound
	}
	if err := driveMemoryEnd(ctx, guard, expires); err != nil {
		return err
	}
	delete(m.sso.providers, providerID)
	for k := range m.sso.identities {
		if k.providerID == providerID {
			delete(m.sso.identities, k)
		}
	}
	for k, st := range m.sso.states {
		if st.ProviderID == providerID {
			delete(m.sso.states, k)
		}
	}
	return nil
}

func (m *Memory) CreateSSOAuthState(_ context.Context, st SSOAuthState) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.initSSOLocked()
	if st.State == "" || st.ProviderID <= 0 || st.CodeVerifier == "" || st.ExpiresAt.IsZero() {
		return ErrConflict
	}
	if _, ok := m.sso.providers[st.ProviderID]; !ok {
		return ErrNotFound
	}
	if _, exists := m.sso.states[st.State]; exists {
		return ErrConflict
	}
	m.sso.states[st.State] = st
	return nil
}

func (m *Memory) ConsumeSSOAuthState(_ context.Context, state string, now time.Time) (SSOAuthState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sso.states == nil {
		return SSOAuthState{}, ErrNotFound
	}
	st, ok := m.sso.states[state]
	if !ok {
		return SSOAuthState{}, ErrNotFound
	}
	// Atomic single-use delete even when expired.
	delete(m.sso.states, state)
	if !now.Before(st.ExpiresAt) {
		return SSOAuthState{}, ErrNotFound
	}
	return st, nil
}

func (m *Memory) ensureWorkspaceMemberLocked(wsID, userID int64, role string) {
	if wsID <= 0 || int(wsID) > len(m.workspaces) {
		return
	}
	if m.member(userID, wsID) {
		return
	}
	m.members[userID] = append(m.members[userID], wsID)
	if m.workspaceRoles == nil {
		m.workspaceRoles = map[[2]int64]string{}
	}
	m.workspaceRoles[[2]int64{wsID, userID}] = normalizeSSODefaultRole(role)
}

func (m *Memory) ResolveOrProvisionSSOUser(_ context.Context, providerID, workspaceID int64, subject, email, name string, autoCreate bool, defaultRole string) (User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.initSSOLocked()

	subject = strings.TrimSpace(subject)
	if providerID <= 0 || subject == "" {
		return User{}, ErrConflict
	}
	if _, ok := m.sso.providers[providerID]; !ok {
		return User{}, ErrNotFound
	}
	email = strings.ToLower(strings.TrimSpace(email))
	role := normalizeSSODefaultRole(defaultRole)
	now := time.Now()
	idKey := ssoIdentityKey{providerID: providerID, subject: subject}

	// 1. Existing linked identity for (provider_id, subject).
	if ident, ok := m.sso.identities[idKey]; ok {
		u := m.userByID(ident.UserID)
		if u != nil {
			ident.LastLoginAt = now
			if email != "" {
				ident.Email = email
			}
			m.sso.identities[idKey] = ident
			m.ensureWorkspaceMemberLocked(workspaceID, u.ID, role)
			return *u, nil
		}
		delete(m.sso.identities, idKey)
	}

	// 2. Match existing local user by email (case-insensitive) and link identity.
	if email != "" {
		for _, u := range m.users {
			if strings.EqualFold(u.Email, email) {
				m.sso.identities[idKey] = SSOIdentity{
					ProviderID:  providerID,
					Subject:     subject,
					UserID:      u.ID,
					Email:       email,
					CreatedAt:   now,
					LastLoginAt: now,
				}
				m.ensureWorkspaceMemberLocked(workspaceID, u.ID, role)
				return u, nil
			}
		}
	}

	// 3. JIT user provisioning if allowed.
	if !autoCreate {
		return User{}, ErrForbidden
	}
	if email == "" {
		email = syntheticSSOEmail(providerID, subject)
	}
	displayName := normalizeSSODisplayName(name, email)
	pwHash, err := randomSSOPasswordHash()
	if err != nil {
		return User{}, err
	}
	u := User{
		ID:           int64(len(m.users) + 1),
		Email:        email,
		Name:         displayName,
		PasswordHash: pwHash,
		CreatedAt:    now,
	}
	m.users = append(m.users, u)

	personalWS := Workspace{
		ID:      int64(len(m.workspaces) + 1),
		Name:    displayName + " 的空间",
		OwnerID: u.ID,
	}
	m.workspaces = append(m.workspaces, personalWS)
	m.members[u.ID] = append(m.members[u.ID], personalWS.ID)
	if m.workspaceRoles == nil {
		m.workspaceRoles = map[[2]int64]string{}
	}
	m.workspaceRoles[[2]int64{personalWS.ID, u.ID}] = WorkspaceRoleOwner

	m.ensureWorkspaceMemberLocked(workspaceID, u.ID, role)
	m.sso.identities[idKey] = SSOIdentity{
		ProviderID:  providerID,
		Subject:     subject,
		UserID:      u.ID,
		Email:       email,
		CreatedAt:   now,
		LastLoginAt: now,
	}
	return u, nil
}

// --- Postgres implementation ---

func ssoPGError(err error) error {
	var pgErr *pgconn.PgError
	if retryableRestoreConflict(err) || (errors.As(err, &pgErr) && (pgErr.Code == "23514" || pgErr.Code == "23505" || pgErr.Code == "23503")) {
		return ErrConflict
	}
	return err
}

func scanSSOProvider(r pgx.Row, includeSecret bool) (SSOProvider, error) {
	var p SSOProvider
	var secretEnc []byte
	err := r.Scan(
		&p.ID, &p.WorkspaceID, &p.Slug, &p.Name, &p.ProviderType, &p.Enabled,
		&p.IssuerURL, &p.AuthURL, &p.TokenURL, &p.UserinfoURL, &p.ClientID,
		&secretEnc, &p.SecretHint, &p.Scopes, &p.AutoCreateUser, &p.DefaultRole,
		&p.AllowedDomains, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt,
	)
	if err != nil {
		return SSOProvider{}, err
	}
	p.HasClientSecret = len(secretEnc) > 0
	if includeSecret {
		p.ClientSecretEnc = secretEnc
	}
	return p, nil
}

const ssoProviderSelectCols = `id, workspace_id, slug, name, provider_type, enabled,
	issuer_url, auth_url, token_url, userinfo_url, client_id,
	client_secret_enc, secret_hint, scopes, auto_create_user, default_role,
	allowed_domains, created_by, created_at, updated_at`

func (p *Postgres) ListPublicSSOProviders(ctx context.Context) ([]PublicSSOProvider, error) {
	rows, err := p.Pool.Query(ctx,
		`SELECT id, slug, name, provider_type
		   FROM sso_providers
		  WHERE enabled = true
		  ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]PublicSSOProvider, 0)
	for rows.Next() {
		var item PublicSSOProvider
		if err := rows.Scan(&item.ID, &item.Slug, &item.Name, &item.ProviderType); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (p *Postgres) GetSSOProviderBySlug(ctx context.Context, slug string) (SSOProvider, error) {
	target := strings.ToLower(strings.TrimSpace(slug))
	row := p.Pool.QueryRow(ctx,
		`SELECT `+ssoProviderSelectCols+` FROM sso_providers WHERE slug = $1`, target)
	prov, err := scanSSOProvider(row, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return SSOProvider{}, ErrNotFound
	}
	return prov, err
}

func (p *Postgres) ListWorkspaceSSOProviders(ctx context.Context, guard RestoreGuard, wsID int64) (out []SSOProvider, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		rows, e := tx.Query(ctx,
			`SELECT `+ssoProviderSelectCols+`
			   FROM sso_providers
			  WHERE workspace_id = $1
			  ORDER BY id ASC`, wsID)
		if e != nil {
			return e
		}
		defer rows.Close()
		out = make([]SSOProvider, 0)
		for rows.Next() {
			var item SSOProvider
			var secretEnc []byte
			if e = rows.Scan(
				&item.ID, &item.WorkspaceID, &item.Slug, &item.Name, &item.ProviderType, &item.Enabled,
				&item.IssuerURL, &item.AuthURL, &item.TokenURL, &item.UserinfoURL, &item.ClientID,
				&secretEnc, &item.SecretHint, &item.Scopes, &item.AutoCreateUser, &item.DefaultRole,
				&item.AllowedDomains, &item.CreatedBy, &item.CreatedAt, &item.UpdatedAt,
			); e != nil {
				return e
			}
			item.HasClientSecret = len(secretEnc) > 0
			out = append(out, item)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, ssoPGError(err)
}

func (p *Postgres) CreateSSOProviderGuarded(ctx context.Context, guard RestoreGuard, wsID int64, in SSOProviderInput) (out SSOProvider, err error) {
	cand := SSOProvider{
		WorkspaceID:     wsID,
		Slug:            in.Slug,
		Name:            in.Name,
		ProviderType:    in.ProviderType,
		Enabled:         in.Enabled,
		IssuerURL:       in.IssuerURL,
		AuthURL:         in.AuthURL,
		TokenURL:        in.TokenURL,
		UserinfoURL:     in.UserinfoURL,
		ClientID:        in.ClientID,
		ClientSecretEnc: in.ClientSecretEnc,
		SecretHint:      in.SecretHint,
		Scopes:          in.Scopes,
		AutoCreateUser:  in.AutoCreateUser,
		DefaultRole:     in.DefaultRole,
		AllowedDomains:  in.AllowedDomains,
	}
	if err := validateSSOProviderFields(&cand); err != nil {
		return SSOProvider{}, err
	}
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		row := tx.QueryRow(ctx,
			`INSERT INTO sso_providers (
				workspace_id, slug, name, provider_type, enabled,
				issuer_url, auth_url, token_url, userinfo_url, client_id,
				client_secret_enc, secret_hint, scopes, auto_create_user, default_role,
				allowed_domains, created_by
			) VALUES (
				$1, $2, $3, $4, $5,
				$6, $7, $8, $9, $10,
				$11, $12, $13, $14, $15,
				$16, $17
			) RETURNING `+ssoProviderSelectCols,
			wsID, cand.Slug, cand.Name, cand.ProviderType, cand.Enabled,
			cand.IssuerURL, cand.AuthURL, cand.TokenURL, cand.UserinfoURL, cand.ClientID,
			cand.ClientSecretEnc, cand.SecretHint, cand.Scopes, cand.AutoCreateUser, cand.DefaultRole,
			cand.AllowedDomains, guard.UserID,
		)
		out, e = scanSSOProvider(row, false)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, ssoPGError(err)
}

func (p *Postgres) UpdateSSOProviderGuarded(ctx context.Context, guard RestoreGuard, wsID, providerID int64, patch SSOProviderPatch) (out SSOProvider, err error) {
	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		cur, e := scanSSOProvider(tx.QueryRow(ctx,
			`SELECT `+ssoProviderSelectCols+` FROM sso_providers WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
			providerID, wsID), true)
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return e
		}
		if patch.Slug != nil {
			cur.Slug = *patch.Slug
		}
		if patch.Name != nil {
			cur.Name = *patch.Name
		}
		if patch.ProviderType != nil {
			cur.ProviderType = *patch.ProviderType
		}
		if patch.Enabled != nil {
			cur.Enabled = *patch.Enabled
		}
		if patch.IssuerURL != nil {
			cur.IssuerURL = *patch.IssuerURL
		}
		if patch.AuthURL != nil {
			cur.AuthURL = *patch.AuthURL
		}
		if patch.TokenURL != nil {
			cur.TokenURL = *patch.TokenURL
		}
		if patch.UserinfoURL != nil {
			cur.UserinfoURL = *patch.UserinfoURL
		}
		if patch.ClientID != nil {
			cur.ClientID = *patch.ClientID
		}
		if patch.UpdateSecret {
			cur.ClientSecretEnc = patch.ClientSecretEnc
			cur.SecretHint = patch.SecretHint
		}
		if patch.Scopes != nil {
			cur.Scopes = *patch.Scopes
		}
		if patch.AutoCreateUser != nil {
			cur.AutoCreateUser = *patch.AutoCreateUser
		}
		if patch.DefaultRole != nil {
			cur.DefaultRole = *patch.DefaultRole
		}
		if patch.AllowedDomains != nil {
			cur.AllowedDomains = *patch.AllowedDomains
		}
		if e = validateSSOProviderFields(&cur); e != nil {
			return e
		}
		out, e = scanSSOProvider(tx.QueryRow(ctx,
			`UPDATE sso_providers
			    SET slug = $3, name = $4, provider_type = $5, enabled = $6,
			        issuer_url = $7, auth_url = $8, token_url = $9, userinfo_url = $10,
			        client_id = $11, client_secret_enc = $12, secret_hint = $13,
			        scopes = $14, auto_create_user = $15, default_role = $16,
			        allowed_domains = $17, updated_at = now()
			  WHERE id = $1 AND workspace_id = $2
			  RETURNING `+ssoProviderSelectCols,
			providerID, wsID,
			cur.Slug, cur.Name, cur.ProviderType, cur.Enabled,
			cur.IssuerURL, cur.AuthURL, cur.TokenURL, cur.UserinfoURL,
			cur.ClientID, cur.ClientSecretEnc, cur.SecretHint,
			cur.Scopes, cur.AutoCreateUser, cur.DefaultRole,
			cur.AllowedDomains,
		), false)
		if e != nil {
			return e
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return out, ssoPGError(err)
}

func (p *Postgres) DeleteSSOProviderGuarded(ctx context.Context, guard RestoreGuard, wsID, providerID int64) error {
	err := pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		expires, e := orgPGRequireAdmin(ctx, tx, guard, wsID)
		if e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `DELETE FROM sso_providers WHERE id = $1 AND workspace_id = $2`, providerID, wsID)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return drivePGEnd(ctx, guard, expires)
	})
	return ssoPGError(err)
}

func (p *Postgres) CreateSSOAuthState(ctx context.Context, st SSOAuthState) error {
	if st.State == "" || st.ProviderID <= 0 || st.CodeVerifier == "" || st.ExpiresAt.IsZero() {
		return ErrConflict
	}
	_, err := p.Pool.Exec(ctx,
		`INSERT INTO sso_auth_states (state, provider_id, code_verifier, nonce, redirect_to, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		st.State, st.ProviderID, st.CodeVerifier, st.Nonce, st.RedirectTo, st.ExpiresAt)
	return ssoPGError(err)
}

func (p *Postgres) ConsumeSSOAuthState(ctx context.Context, state string, now time.Time) (SSOAuthState, error) {
	var st SSOAuthState
	err := p.Pool.QueryRow(ctx,
		`DELETE FROM sso_auth_states
		  WHERE state = $1
		  RETURNING state, provider_id, code_verifier, nonce, redirect_to, expires_at`,
		state,
	).Scan(&st.State, &st.ProviderID, &st.CodeVerifier, &st.Nonce, &st.RedirectTo, &st.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return SSOAuthState{}, ErrNotFound
	}
	if err != nil {
		return SSOAuthState{}, err
	}
	if !now.Before(st.ExpiresAt) {
		return SSOAuthState{}, ErrNotFound
	}
	return st, nil
}

func (p *Postgres) ResolveOrProvisionSSOUser(ctx context.Context, providerID, workspaceID int64, subject, email, name string, autoCreate bool, defaultRole string) (out User, err error) {
	subject = strings.TrimSpace(subject)
	if providerID <= 0 || subject == "" {
		return User{}, ErrConflict
	}
	email = strings.ToLower(strings.TrimSpace(email))
	role := normalizeSSODefaultRole(defaultRole)

	err = pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		ensureMember := func(userID int64) error {
			if workspaceID <= 0 {
				return nil
			}
			_, e := tx.Exec(ctx,
				`INSERT INTO workspace_members (workspace_id, user_id, role)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (workspace_id, user_id) DO NOTHING`,
				workspaceID, userID, role)
			return e
		}

		// 1. Existing identity for (provider_id, subject).
		var u User
		e := tx.QueryRow(ctx,
			`SELECT u.id, u.email, u.name, u.password_hash, u.created_at
			   FROM sso_identities i
			   JOIN users u ON u.id = i.user_id
			  WHERE i.provider_id = $1 AND i.subject = $2`,
			providerID, subject,
		).Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.CreatedAt)
		if e == nil {
			if _, e = tx.Exec(ctx,
				`UPDATE sso_identities
				    SET last_login_at = now(),
				        email = CASE WHEN $3 <> '' THEN $3 ELSE email END
				  WHERE provider_id = $1 AND subject = $2`,
				providerID, subject, email); e != nil {
				return e
			}
			if e = ensureMember(u.ID); e != nil {
				return e
			}
			out = u
			return nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}

		// 2. Existing user matched by email (case-insensitive).
		if email != "" {
			e = tx.QueryRow(ctx,
				`SELECT id, email, name, password_hash, created_at
				   FROM users
				  WHERE lower(email) = lower($1)`,
				email,
			).Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.CreatedAt)
			if e == nil {
				if _, e = tx.Exec(ctx,
					`INSERT INTO sso_identities (provider_id, subject, user_id, email)
					 VALUES ($1, $2, $3, $4)
					 ON CONFLICT (provider_id, subject) DO UPDATE
					   SET last_login_at = now(),
					       email = CASE WHEN EXCLUDED.email <> '' THEN EXCLUDED.email ELSE sso_identities.email END`,
					providerID, subject, u.ID, email); e != nil {
					return e
				}
				if e = ensureMember(u.ID); e != nil {
					return e
				}
				out = u
				return nil
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}

		// 3. JIT user creation.
		if !autoCreate {
			return ErrForbidden
		}
		provisionEmail := email
		if provisionEmail == "" {
			provisionEmail = syntheticSSOEmail(providerID, subject)
		}
		displayName := normalizeSSODisplayName(name, provisionEmail)
		pwHash, e := randomSSOPasswordHash()
		if e != nil {
			return e
		}
		if e = tx.QueryRow(ctx,
			`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
			 RETURNING id, email, name, password_hash, created_at`,
			provisionEmail, displayName, pwHash,
		).Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.CreatedAt); e != nil {
			return e
		}
		var personalWSID int64
		if e = tx.QueryRow(ctx,
			`INSERT INTO workspaces (name, owner_id) VALUES ($1, $2) RETURNING id`,
			displayName+" 的空间", u.ID,
		).Scan(&personalWSID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx,
			`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
			personalWSID, u.ID); e != nil {
			return e
		}
		if e = ensureMember(u.ID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx,
			`INSERT INTO sso_identities (provider_id, subject, user_id, email)
			 VALUES ($1, $2, $3, $4)`,
			providerID, subject, u.ID, provisionEmail); e != nil {
			return e
		}
		out = u
		return nil
	})
	return out, ssoPGError(err)
}
