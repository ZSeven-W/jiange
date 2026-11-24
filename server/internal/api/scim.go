package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	scimContentType = "application/scim+json"

	scimSchemaUser                  = "urn:ietf:params:scim:schemas:core:2.0:User"
	scimSchemaGroup                 = "urn:ietf:params:scim:schemas:core:2.0:Group"
	scimSchemaListResponse          = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
	scimSchemaPatchOp               = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
	scimSchemaError                 = "urn:ietf:params:scim:api:messages:2.0:Error"
	scimSchemaServiceProviderConfig = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"

	scimDefaultPageSize = 100
	scimMaxPageSize     = 200
)

// --- SCIM 2.0 wire types (RFC 7643 / 7644) ---

type scimErrorResponse struct {
	Schemas  []string `json:"schemas"`
	ScimType string   `json:"scimType,omitempty"`
	Detail   string   `json:"detail"`
	Status   string   `json:"status"`
}

type scimMeta struct {
	ResourceType string `json:"resourceType"`
	Created      string `json:"created,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
	Location     string `json:"location,omitempty"`
}

type scimUserName struct {
	Formatted  string `json:"formatted,omitempty"`
	GivenName  string `json:"givenName,omitempty"`
	FamilyName string `json:"familyName,omitempty"`
}

type scimUserEmail struct {
	Value   string `json:"value"`
	Type    string `json:"type,omitempty"`
	Primary bool   `json:"primary"`
}

type scimUserRole struct {
	Value   string `json:"value"`
	Display string `json:"display,omitempty"`
	Primary bool   `json:"primary,omitempty"`
}

type scimRefItem struct {
	Value   string `json:"value"`
	Display string `json:"display,omitempty"`
	Ref     string `json:"$ref,omitempty"`
}

type scimUserResource struct {
	Schemas     []string        `json:"schemas"`
	ID          string          `json:"id"`
	ExternalID  string          `json:"externalId,omitempty"`
	UserName    string          `json:"userName"`
	Name        *scimUserName   `json:"name,omitempty"`
	DisplayName string          `json:"displayName,omitempty"`
	Active      bool            `json:"active"`
	Emails      []scimUserEmail `json:"emails,omitempty"`
	Roles       []scimUserRole  `json:"roles,omitempty"`
	Groups      []scimRefItem   `json:"groups,omitempty"`
	Meta        scimMeta        `json:"meta"`
}

type scimGroupResource struct {
	Schemas     []string      `json:"schemas"`
	ID          string        `json:"id"`
	ExternalID  string        `json:"externalId,omitempty"`
	DisplayName string        `json:"displayName"`
	Members     []scimRefItem `json:"members"`
	Meta        scimMeta      `json:"meta"`
}

type scimListResponse struct {
	Schemas      []string `json:"schemas"`
	TotalResults int      `json:"totalResults"`
	StartIndex   int      `json:"startIndex"`
	ItemsPerPage int      `json:"itemsPerPage"`
	Resources    []any    `json:"Resources"`
}

type scimPatchOperation struct {
	Op    string          `json:"op"`
	Path  string          `json:"path,omitempty"`
	Value json.RawMessage `json:"value,omitempty"`
}

type scimPatchOpRequest struct {
	Schemas    []string             `json:"schemas"`
	Operations []scimPatchOperation `json:"Operations"`
}

type scimCreateUserRequest struct {
	Schemas     []string        `json:"schemas"`
	ExternalID  string          `json:"externalId"`
	UserName    string          `json:"userName"`
	DisplayName string          `json:"displayName"`
	Name        *scimUserName   `json:"name"`
	Active      *bool           `json:"active"`
	Emails      []scimUserEmail `json:"emails"`
	Roles       []scimUserRole  `json:"roles"`
	Role        string          `json:"role"`
}

type scimCreateGroupRequest struct {
	Schemas     []string      `json:"schemas"`
	ExternalID  string        `json:"externalId"`
	DisplayName string        `json:"displayName"`
	Members     []scimRefItem `json:"members"`
}

// --- SCIM response & decode helpers ---

func writeSCIMJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", scimContentType)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeSCIMError(w http.ResponseWriter, status int, scimType, detail string) {
	writeSCIMJSON(w, status, scimErrorResponse{
		Schemas:  []string{scimSchemaError},
		ScimType: scimType,
		Detail:   detail,
		Status:   strconv.Itoa(status),
	})
}

func decodeSCIMJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		writeSCIMError(w, http.StatusBadRequest, "invalidSyntax", "invalid SCIM JSON request body")
		return false
	}
	return true
}

func patHasAdminScope(scopes []string) bool {
	for _, sc := range scopes {
		if strings.EqualFold(strings.TrimSpace(sc), store.PATScopeAdmin) {
			return true
		}
	}
	return false
}

func isSCIMWorkspaceAdminRole(role string) bool {
	return role == store.WorkspaceRoleOwner || role == store.WorkspaceRoleAdmin
}

type scimAuthContext struct {
	User        store.User
	WorkspaceID int64
	Org         store.WorkspaceOrgSnapshot
	Guard       store.RestoreGuard
	Req         *http.Request
	Cleanup     func()
}

// authenticateSCIM authenticates a SCIM 2.0 request via either an admin-scoped
// Bearer PAT (`Authorization: Bearer jg_pat_...`) or an active session cookie,
// resolves the target workspace (`?workspaceId=` or `X-Jiange-Workspace-Id`,
// defaulting to the caller's first owner/admin workspace), and verifies that
// the caller holds owner or admin permissions on that workspace.
func (s *Server) authenticateSCIM(w http.ResponseWriter, r *http.Request) (scimAuthContext, bool) {
	w.Header().Set("Cache-Control", "no-store")

	var (
		u       store.User
		guard   store.RestoreGuard
		cleanup = func() {}
		viaPAT  bool
	)

	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if authHeader != "" {
		patUser, pat, ok := s.authenticateBearerPAT(r)
		if !ok {
			writeSCIMError(w, http.StatusUnauthorized, "", "invalid or expired bearer personal access token")
			return scimAuthContext{}, false
		}
		if !patHasAdminScope(pat.Scopes) {
			writeSCIMError(w, http.StatusForbidden, "", "SCIM 2.0 provisioning requires a Personal Access Token with admin scope")
			return scimAuthContext{}, false
		}
		_, sessHash, err := auth.NewToken()
		if err != nil {
			writeSCIMError(w, http.StatusInternalServerError, "", "failed to initialize provisioning guard")
			return scimAuthContext{}, false
		}
		if err := s.Store.CreateSession(r.Context(), sessHash, patUser.ID, s.now().UTC().Add(2*time.Minute)); err != nil {
			writeSCIMError(w, http.StatusInternalServerError, "", "failed to initialize provisioning guard")
			return scimAuthContext{}, false
		}
		u = patUser
		viaPAT = true
		guard = store.RestoreGuard{
			UserID:      u.ID,
			SessionHash: sessHash,
			Now:         func() time.Time { return s.now() },
		}
		cleanup = func() {
			_ = s.Store.DeleteSession(context.Background(), sessHash)
		}
	} else {
		c, err := r.Cookie(CookieName)
		if err != nil || c.Value == "" {
			writeSCIMError(w, http.StatusUnauthorized, "", "authentication required")
			return scimAuthContext{}, false
		}
		sessHash := auth.HashToken(c.Value)
		sessUser, err := s.Store.SessionUser(r.Context(), sessHash, s.now())
		if err != nil {
			writeSCIMError(w, http.StatusUnauthorized, "", "session expired or invalid")
			return scimAuthContext{}, false
		}
		u = sessUser
		guard = store.RestoreGuard{
			UserID:      u.ID,
			SessionHash: sessHash,
			Now:         func() time.Time { return s.now() },
		}
	}

	rawWS := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	if rawWS == "" {
		rawWS = strings.TrimSpace(r.Header.Get("X-Jiange-Workspace-Id"))
	}

	var (
		wsID int64
		snap store.WorkspaceOrgSnapshot
	)

	if rawWS != "" {
		parsed, err := strconv.ParseInt(rawWS, 10, 64)
		if err != nil || parsed <= 0 {
			cleanup()
			writeSCIMError(w, http.StatusBadRequest, "invalidValue", "workspaceId must be a positive integer")
			return scimAuthContext{}, false
		}
		orgSnap, err := s.Store.GetWorkspaceOrg(r.Context(), guard, parsed)
		if err != nil {
			cleanup()
			switch {
			case errors.Is(err, store.ErrNotFound):
				writeSCIMError(w, http.StatusNotFound, "", "workspace not found")
			case errors.Is(err, store.ErrForbidden):
				writeSCIMError(w, http.StatusForbidden, "", "workspace owner or admin role is required")
			case errors.Is(err, store.ErrUnauthenticated):
				writeSCIMError(w, http.StatusUnauthorized, "", "authentication invalid or expired")
			default:
				writeSCIMError(w, http.StatusInternalServerError, "", "failed to load workspace organization")
			}
			return scimAuthContext{}, false
		}
		if !isSCIMWorkspaceAdminRole(orgSnap.CallerRole) {
			cleanup()
			writeSCIMError(w, http.StatusForbidden, "", "workspace owner or admin role is required for SCIM provisioning")
			return scimAuthContext{}, false
		}
		wsID = parsed
		snap = orgSnap
	} else {
		workspaces, err := s.Store.Workspaces(r.Context(), u.ID)
		if err != nil {
			cleanup()
			writeSCIMError(w, http.StatusInternalServerError, "", "failed to resolve caller workspaces")
			return scimAuthContext{}, false
		}
		found := false
		for _, ws := range workspaces {
			orgSnap, err := s.Store.GetWorkspaceOrg(r.Context(), guard, ws.ID)
			if err != nil {
				continue
			}
			if isSCIMWorkspaceAdminRole(orgSnap.CallerRole) {
				wsID = ws.ID
				snap = orgSnap
				found = true
				break
			}
		}
		if !found {
			cleanup()
			writeSCIMError(w, http.StatusForbidden, "", "no workspace with owner or admin privileges found for caller")
			return scimAuthContext{}, false
		}
	}

	actorKind := "user"
	if viaPAT {
		actorKind = "pat"
	}
	ctx := context.WithValue(r.Context(), userKey, u)
	ctx = store.WithActor(ctx, store.Actor{UserID: u.ID, Kind: actorKind})

	return scimAuthContext{
		User:        u,
		WorkspaceID: wsID,
		Org:         snap,
		Guard:       guard,
		Req:         r.WithContext(ctx),
		Cleanup:     cleanup,
	}, true
}

// --- SCIM filter & pagination helpers ---

type scimFilterExpr struct {
	Attr  string
	Op    string
	Value string
}

func parseSCIMFilter(raw string) (*scimFilterExpr, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, nil
	}
	for strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		inner := strings.TrimSpace(s[1 : len(s)-1])
		if inner == "" {
			return nil, errors.New("empty filter")
		}
		s = inner
	}

	// Find attribute token up to the first whitespace outside brackets (to support
	// paths like `emails[type eq "work"].value eq "alice@example.com"`).
	bracketDepth := 0
	attrEnd := -1
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '[':
			bracketDepth++
		case ']':
			if bracketDepth > 0 {
				bracketDepth--
			}
		case ' ', '\t':
			if bracketDepth == 0 {
				attrEnd = i
			}
		}
		if attrEnd != -1 {
			break
		}
	}
	if attrEnd <= 0 {
		return nil, errors.New("invalid filter syntax")
	}
	attr := strings.ToLower(strings.TrimSpace(s[:attrEnd]))
	rest := strings.TrimSpace(s[attrEnd:])

	opIdx := strings.IndexAny(rest, " \t")
	if opIdx <= 0 {
		return nil, errors.New("invalid filter operator")
	}
	op := strings.ToLower(strings.TrimSpace(rest[:opIdx]))
	if op != "eq" && op != "co" && op != "sw" {
		return nil, fmt.Errorf("unsupported filter operator %q", op)
	}
	valRaw := strings.TrimSpace(rest[opIdx:])
	if valRaw == "" {
		return nil, errors.New("missing filter value")
	}
	var val string
	if (strings.HasPrefix(valRaw, `"`) && strings.HasSuffix(valRaw, `"`)) ||
		(strings.HasPrefix(valRaw, `'`) && strings.HasSuffix(valRaw, `'`)) {
		if len(valRaw) < 2 {
			return nil, errors.New("unterminated filter string")
		}
		val = valRaw[1 : len(valRaw)-1]
	} else {
		val = valRaw
	}

	return &scimFilterExpr{
		Attr:  attr,
		Op:    op,
		Value: val,
	}, nil
}

func matchSCIMString(candidate string, expr *scimFilterExpr) bool {
	if expr == nil {
		return true
	}
	c := strings.ToLower(strings.TrimSpace(candidate))
	v := strings.ToLower(strings.TrimSpace(expr.Value))
	switch expr.Op {
	case "eq":
		return c == v
	case "co":
		return strings.Contains(c, v)
	case "sw":
		return strings.HasPrefix(c, v)
	default:
		return false
	}
}

func matchSCIMUser(m store.WorkspaceMemberInfo, expr *scimFilterExpr) bool {
	if expr == nil {
		return true
	}
	switch {
	case expr.Attr == "username" || expr.Attr == "emails.value" || strings.HasPrefix(expr.Attr, "emails["):
		return matchSCIMString(m.Email, expr)
	case expr.Attr == "displayname" || expr.Attr == "name.formatted":
		return matchSCIMString(m.Name, expr)
	case expr.Attr == "id":
		return matchSCIMString(strconv.FormatInt(m.UserID, 10), expr)
	case expr.Attr == "active":
		return strings.EqualFold(expr.Value, "true")
	default:
		return false
	}
}

func matchSCIMGroup(g store.OrgGroup, expr *scimFilterExpr) bool {
	if expr == nil {
		return true
	}
	switch expr.Attr {
	case "displayname":
		return matchSCIMString(g.Name, expr)
	case "id":
		return matchSCIMString(strconv.FormatInt(g.ID, 10), expr)
	case "externalid":
		return matchSCIMString(g.ExternalID, expr)
	default:
		return false
	}
}

func parseSCIMPagination(w http.ResponseWriter, r *http.Request) (startIndex, count int, ok bool) {
	startIndex = 1
	count = scimDefaultPageSize
	q := r.URL.Query()
	if raw := strings.TrimSpace(q.Get("startIndex")); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil {
			writeSCIMError(w, http.StatusBadRequest, "invalidValue", "startIndex must be an integer")
			return 0, 0, false
		}
		if v < 1 {
			v = 1
		}
		startIndex = v
	}
	if raw := strings.TrimSpace(q.Get("count")); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil {
			writeSCIMError(w, http.StatusBadRequest, "invalidValue", "count must be an integer")
			return 0, 0, false
		}
		if v < 0 {
			v = 0
		}
		if v > scimMaxPageSize {
			v = scimMaxPageSize
		}
		count = v
	}
	return startIndex, count, true
}

func paginateSCIMItems(items []any, startIndex, count int) scimListResponse {
	total := len(items)
	startZero := startIndex - 1
	page := []any{}
	if count > 0 && startZero < total {
		end := startZero + count
		if end > total {
			end = total
		}
		page = items[startZero:end]
	}
	return scimListResponse{
		Schemas:      []string{scimSchemaListResponse},
		TotalResults: total,
		StartIndex:   startIndex,
		ItemsPerPage: len(page),
		Resources:    page,
	}
}

// --- SCIM resource builders ---

func buildSCIMUserResource(m store.WorkspaceMemberInfo, groups []store.OrgGroup, active bool) scimUserResource {
	userGroups := make([]scimRefItem, 0)
	for _, g := range groups {
		for _, gm := range g.Members {
			if gm.UserID == m.UserID {
				userGroups = append(userGroups, scimRefItem{
					Value:   strconv.FormatInt(g.ID, 10),
					Display: g.Name,
					Ref:     fmt.Sprintf("/scim/v2/Groups/%d", g.ID),
				})
				break
			}
		}
	}
	created := ""
	if !m.CreatedAt.IsZero() {
		created = m.CreatedAt.UTC().Format(time.RFC3339)
	}
	res := scimUserResource{
		Schemas:     []string{scimSchemaUser},
		ID:          strconv.FormatInt(m.UserID, 10),
		UserName:    m.Email,
		DisplayName: m.Name,
		Name: &scimUserName{
			Formatted: m.Name,
		},
		Active: active,
		Emails: []scimUserEmail{
			{
				Value:   m.Email,
				Type:    "work",
				Primary: true,
			},
		},
		Roles: []scimUserRole{
			{
				Value:   m.Role,
				Display: m.Role,
				Primary: true,
			},
		},
		Meta: scimMeta{
			ResourceType: "User",
			Created:      created,
			Location:     fmt.Sprintf("/scim/v2/Users/%d", m.UserID),
		},
	}
	if len(userGroups) > 0 {
		res.Groups = userGroups
	}
	return res
}

func buildSCIMGroupResource(g store.OrgGroup) scimGroupResource {
	members := make([]scimRefItem, 0, len(g.Members))
	for _, m := range g.Members {
		members = append(members, scimRefItem{
			Value:   strconv.FormatInt(m.UserID, 10),
			Display: m.Name,
			Ref:     fmt.Sprintf("/scim/v2/Users/%d", m.UserID),
		})
	}
	created := ""
	if !g.CreatedAt.IsZero() {
		created = g.CreatedAt.UTC().Format(time.RFC3339)
	}
	updated := ""
	if !g.UpdatedAt.IsZero() {
		updated = g.UpdatedAt.UTC().Format(time.RFC3339)
	}
	return scimGroupResource{
		Schemas:     []string{scimSchemaGroup},
		ID:          strconv.FormatInt(g.ID, 10),
		ExternalID:  g.ExternalID,
		DisplayName: g.Name,
		Members:     members,
		Meta: scimMeta{
			ResourceType: "Group",
			Created:      created,
			LastModified: updated,
			Location:     fmt.Sprintf("/scim/v2/Groups/%d", g.ID),
		},
	}
}

func findWorkspaceMemberByID(members []store.WorkspaceMemberInfo, uid int64) (store.WorkspaceMemberInfo, bool) {
	for _, m := range members {
		if m.UserID == uid {
			return m, true
		}
	}
	return store.WorkspaceMemberInfo{}, false
}

func findWorkspaceMemberByEmail(members []store.WorkspaceMemberInfo, email string) (store.WorkspaceMemberInfo, bool) {
	for _, m := range members {
		if strings.EqualFold(m.Email, email) {
			return m, true
		}
	}
	return store.WorkspaceMemberInfo{}, false
}

func findWorkspaceGroupByID(groups []store.OrgGroup, gid int64) (store.OrgGroup, bool) {
	for _, g := range groups {
		if g.ID == gid {
			return g, true
		}
	}
	return store.OrgGroup{}, false
}

// --- SCIM ServiceProviderConfig ---

// scimServiceProviderConfig handles GET /scim/v2/ServiceProviderConfig.
func (s *Server) scimServiceProviderConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=300")
	writeSCIMJSON(w, http.StatusOK, map[string]any{
		"schemas":          []string{scimSchemaServiceProviderConfig},
		"documentationUri": "/api/openapi.json",
		"patch":            map[string]any{"supported": true},
		"bulk":             map[string]any{"supported": false, "maxOperations": 0, "maxPayloadSize": 0},
		"filter":           map[string]any{"supported": true, "maxResults": scimMaxPageSize},
		"changePassword":   map[string]any{"supported": false},
		"sort":             map[string]any{"supported": false},
		"etag":             map[string]any{"supported": false},
		"authenticationSchemes": []map[string]any{
			{
				"type":        "oauthbearertoken",
				"name":        "Bearer Personal Access Token",
				"description": "Authenticate using a Jiange Personal Access Token (jg_pat_...) with admin scope via the Authorization: Bearer header.",
				"specUri":     "https://datatracker.ietf.org/doc/html/rfc6750",
				"primary":     true,
			},
		},
		"meta": scimMeta{
			ResourceType: "ServiceProviderConfig",
			Location:     "/scim/v2/ServiceProviderConfig",
		},
	})
}

// --- SCIM Users endpoints ---

// scimListUsers handles GET /scim/v2/Users.
func (s *Server) scimListUsers(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := s.authenticateSCIM(w, r)
	if !ok {
		return
	}
	defer authCtx.Cleanup()

	filter, err := parseSCIMFilter(r.URL.Query().Get("filter"))
	if err != nil {
		writeSCIMError(w, http.StatusBadRequest, "invalidFilter", err.Error())
		return
	}
	startIndex, count, ok := parseSCIMPagination(w, r)
	if !ok {
		return
	}

	matched := make([]any, 0, len(authCtx.Org.Members))
	for _, m := range authCtx.Org.Members {
		if matchSCIMUser(m, filter) {
			matched = append(matched, buildSCIMUserResource(m, authCtx.Org.Groups, true))
		}
	}
	writeSCIMJSON(w, http.StatusOK, paginateSCIMItems(matched, startIndex, count))
}

func extractSCIMUserEmail(in scimCreateUserRequest) (string, bool) {
	if email, ok := store.NormalizeInviteEmail(in.UserName); ok {
		return email, true
	}
	for _, e := range in.Emails {
		if e.Primary {
			if email, ok := store.NormalizeInviteEmail(e.Value); ok {
				return email, true
			}
		}
	}
	for _, e := range in.Emails {
		if email, ok := store.NormalizeInviteEmail(e.Value); ok {
			return email, true
		}
	}
	return "", false
}

func extractSCIMDisplayName(in scimCreateUserRequest, email string) string {
	name := strings.TrimSpace(in.DisplayName)
	if name == "" && in.Name != nil {
		if f := strings.TrimSpace(in.Name.Formatted); f != "" {
			name = f
		} else {
			name = strings.TrimSpace(strings.TrimSpace(in.Name.GivenName) + " " + strings.TrimSpace(in.Name.FamilyName))
		}
	}
	if name == "" {
		local, _, _ := strings.Cut(email, "@")
		name = strings.TrimSpace(local)
	}
	if name == "" {
		name = "User"
	}
	if utf8.RuneCountInString(name) > 64 {
		runes := []rune(name)
		name = string(runes[:64])
	}
	return name
}

func extractSCIMWorkspaceRole(roles []scimUserRole, fallback string) string {
	for _, r := range roles {
		switch strings.ToLower(strings.TrimSpace(r.Value)) {
		case store.WorkspaceRoleAdmin:
			return store.WorkspaceRoleAdmin
		case store.WorkspaceRoleMember:
			return store.WorkspaceRoleMember
		}
	}
	switch strings.ToLower(strings.TrimSpace(fallback)) {
	case store.WorkspaceRoleAdmin:
		return store.WorkspaceRoleAdmin
	default:
		return store.WorkspaceRoleMember
	}
}

func generateSCIMProvisionedPasswordHash(iterations int) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	if iterations <= 0 {
		iterations = auth.DefaultIterations
	}
	return auth.HashPassword(base64.RawURLEncoding.EncodeToString(b), iterations)
}

// scimCreateUser handles POST /scim/v2/Users.
func (s *Server) scimCreateUser(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := s.authenticateSCIM(w, r)
	if !ok {
		return
	}
	defer authCtx.Cleanup()

	var in scimCreateUserRequest
	if !decodeSCIMJSON(w, r, &in) {
		return
	}
	email, validEmail := extractSCIMUserEmail(in)
	if !validEmail {
		writeSCIMError(w, http.StatusBadRequest, "invalidValue", "a valid email address in userName or emails is required")
		return
	}
	if _, exists := findWorkspaceMemberByEmail(authCtx.Org.Members, email); exists {
		writeSCIMError(w, http.StatusConflict, "uniqueness", "user already provisioned in this workspace")
		return
	}

	displayName := extractSCIMDisplayName(in, email)
	targetRole := extractSCIMWorkspaceRole(in.Roles, in.Role)

	createdAccount := false
	u, err := s.Store.UserByEmail(r.Context(), email)
	if errors.Is(err, store.ErrNotFound) {
		pwdHash, hashErr := generateSCIMProvisionedPasswordHash(s.Iterations)
		if hashErr != nil {
			writeSCIMError(w, http.StatusInternalServerError, "", "failed to provision user credentials")
			return
		}
		u, _, err = s.Store.CreateUser(r.Context(), email, displayName, pwdHash)
		if errors.Is(err, store.ErrConflict) {
			u, err = s.Store.UserByEmail(r.Context(), email)
		} else if err == nil {
			createdAccount = true
		}
	}
	if err != nil {
		writeSCIMError(w, http.StatusInternalServerError, "", "failed to create or look up user account")
		return
	}

	if err := s.Store.AddWorkspaceMember(r.Context(), authCtx.WorkspaceID, u.ID); err != nil {
		writeSCIMError(w, http.StatusInternalServerError, "", "failed to add user to workspace")
		return
	}

	if targetRole == store.WorkspaceRoleAdmin {
		if _, err := s.Store.UpsertWorkspaceMemberGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, email, store.WorkspaceRoleAdmin); err != nil {
			writeSCIMError(w, http.StatusInternalServerError, "", "failed to assign workspace admin role")
			return
		}
	}

	refreshed, err := s.Store.GetWorkspaceOrg(r.Context(), authCtx.Guard, authCtx.WorkspaceID)
	if err != nil {
		writeSCIMError(w, http.StatusInternalServerError, "", "failed to reload provisioned user")
		return
	}
	member, found := findWorkspaceMemberByID(refreshed.Members, u.ID)
	if !found {
		member = store.WorkspaceMemberInfo{
			UserID:    u.ID,
			Email:     u.Email,
			Name:      u.Name,
			Role:      targetRole,
			CreatedAt: u.CreatedAt,
		}
	}

	s.recordAudit(authCtx.Req, authCtx.WorkspaceID, "scim.user_provision", "user", member.UserID, member.Email, map[string]any{
		"email":          member.Email,
		"displayName":    member.Name,
		"role":           member.Role,
		"createdAccount": createdAccount,
	})

	res := buildSCIMUserResource(member, refreshed.Groups, true)
	w.Header().Set("Location", res.Meta.Location)
	writeSCIMJSON(w, http.StatusCreated, res)
}

// scimGetUser handles GET /scim/v2/Users/{uid}.
func (s *Server) scimGetUser(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := s.authenticateSCIM(w, r)
	if !ok {
		return
	}
	defer authCtx.Cleanup()

	uid, err := strconv.ParseInt(r.PathValue("uid"), 10, 64)
	if err != nil || uid <= 0 {
		writeSCIMError(w, http.StatusNotFound, "", "user not found")
		return
	}
	member, found := findWorkspaceMemberByID(authCtx.Org.Members, uid)
	if !found {
		writeSCIMError(w, http.StatusNotFound, "", "user not found in workspace")
		return
	}
	writeSCIMJSON(w, http.StatusOK, buildSCIMUserResource(member, authCtx.Org.Groups, true))
}

func parseSCIMBool(raw json.RawMessage) (bool, bool) {
	var b bool
	if err := json.Unmarshal(raw, &b); err == nil {
		return b, true
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		switch strings.ToLower(strings.TrimSpace(str)) {
		case "true":
			return true, true
		case "false":
			return false, true
		}
	}
	return false, false
}

func parseSCIMRolesValue(raw json.RawMessage) (string, bool) {
	var roles []scimUserRole
	if err := json.Unmarshal(raw, &roles); err == nil {
		for _, r := range roles {
			v := strings.ToLower(strings.TrimSpace(r.Value))
			if v == store.WorkspaceRoleAdmin || v == store.WorkspaceRoleMember {
				return v, true
			}
		}
		return "", false
	}
	var single scimUserRole
	if err := json.Unmarshal(raw, &single); err == nil {
		v := strings.ToLower(strings.TrimSpace(single.Value))
		if v == store.WorkspaceRoleAdmin || v == store.WorkspaceRoleMember {
			return v, true
		}
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		v := strings.ToLower(strings.TrimSpace(str))
		if v == store.WorkspaceRoleAdmin || v == store.WorkspaceRoleMember {
			return v, true
		}
	}
	return "", false
}

// scimPatchUser handles PATCH /scim/v2/Users/{uid}.
func (s *Server) scimPatchUser(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := s.authenticateSCIM(w, r)
	if !ok {
		return
	}
	defer authCtx.Cleanup()

	uid, err := strconv.ParseInt(r.PathValue("uid"), 10, 64)
	if err != nil || uid <= 0 {
		writeSCIMError(w, http.StatusNotFound, "", "user not found")
		return
	}
	member, found := findWorkspaceMemberByID(authCtx.Org.Members, uid)
	if !found {
		writeSCIMError(w, http.StatusNotFound, "", "user not found in workspace")
		return
	}

	var patch scimPatchOpRequest
	if !decodeSCIMJSON(w, r, &patch) {
		return
	}
	if len(patch.Operations) == 0 {
		writeSCIMError(w, http.StatusBadRequest, "invalidSyntax", "Operations must contain at least one patch operation")
		return
	}

	deactivate := false
	targetRole := ""

	for _, op := range patch.Operations {
		verb := strings.ToLower(strings.TrimSpace(op.Op))
		if verb != "replace" && verb != "add" && verb != "remove" {
			writeSCIMError(w, http.StatusBadRequest, "invalidSyntax", fmt.Sprintf("unsupported patch op %q", op.Op))
			return
		}
		path := strings.ToLower(strings.TrimSpace(op.Path))

		switch {
		case path == "active":
			if verb == "remove" {
				deactivate = true
			} else if val, parsed := parseSCIMBool(op.Value); parsed && !val {
				deactivate = true
			} else if !parsed {
				writeSCIMError(w, http.StatusBadRequest, "invalidValue", "active must be a boolean")
				return
			}
		case path == "roles" || strings.HasPrefix(path, "roles["):
			if verb == "remove" {
				targetRole = store.WorkspaceRoleMember
			} else if role, parsed := parseSCIMRolesValue(op.Value); parsed {
				targetRole = role
			}
		case path == "":
			if len(op.Value) == 0 {
				continue
			}
			var obj map[string]json.RawMessage
			if err := json.Unmarshal(op.Value, &obj); err != nil {
				writeSCIMError(w, http.StatusBadRequest, "invalidSyntax", "patch operation without path must provide an object value")
				return
			}
			for k, v := range obj {
				switch strings.ToLower(strings.TrimSpace(k)) {
				case "active":
					if val, parsed := parseSCIMBool(v); parsed && !val {
						deactivate = true
					} else if !parsed {
						writeSCIMError(w, http.StatusBadRequest, "invalidValue", "active must be a boolean")
						return
					}
				case "roles":
					if role, parsed := parseSCIMRolesValue(v); parsed {
						targetRole = role
					}
				}
			}
		}
	}

	if deactivate {
		if member.Role == store.WorkspaceRoleOwner {
			writeSCIMError(w, http.StatusForbidden, "mutability", "cannot deprovision workspace owner")
			return
		}
		if _, err := s.Store.UpsertWorkspaceMemberGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, member.Email, "remove"); err != nil {
			if errors.Is(err, store.ErrForbidden) {
				writeSCIMError(w, http.StatusForbidden, "mutability", "cannot deprovision workspace owner")
				return
			}
			writeSCIMError(w, http.StatusInternalServerError, "", "failed to deprovision user")
			return
		}
		s.recordAudit(authCtx.Req, authCtx.WorkspaceID, "scim.user_deprovision", "user", member.UserID, member.Email, map[string]any{
			"email": member.Email,
			"via":   "patch_active_false",
		})
		writeSCIMJSON(w, http.StatusOK, buildSCIMUserResource(member, nil, false))
		return
	}

	if targetRole != "" && targetRole != member.Role {
		if member.Role == store.WorkspaceRoleOwner {
			writeSCIMError(w, http.StatusForbidden, "mutability", "cannot modify workspace owner role")
			return
		}
		if _, err := s.Store.UpsertWorkspaceMemberGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, member.Email, targetRole); err != nil {
			if errors.Is(err, store.ErrForbidden) {
				writeSCIMError(w, http.StatusForbidden, "mutability", "cannot modify workspace owner role")
				return
			}
			writeSCIMError(w, http.StatusInternalServerError, "", "failed to update user role")
			return
		}
		member.Role = targetRole
	}

	refreshed, err := s.Store.GetWorkspaceOrg(r.Context(), authCtx.Guard, authCtx.WorkspaceID)
	if err == nil {
		if updated, ok := findWorkspaceMemberByID(refreshed.Members, member.UserID); ok {
			member = updated
		}
		authCtx.Org = refreshed
	}

	s.recordAudit(authCtx.Req, authCtx.WorkspaceID, "scim.user_update", "user", member.UserID, member.Email, map[string]any{
		"email": member.Email,
		"role":  member.Role,
	})
	writeSCIMJSON(w, http.StatusOK, buildSCIMUserResource(member, authCtx.Org.Groups, true))
}

// scimDeleteUser handles DELETE /scim/v2/Users/{uid}.
func (s *Server) scimDeleteUser(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := s.authenticateSCIM(w, r)
	if !ok {
		return
	}
	defer authCtx.Cleanup()

	uid, err := strconv.ParseInt(r.PathValue("uid"), 10, 64)
	if err != nil || uid <= 0 {
		writeSCIMError(w, http.StatusNotFound, "", "user not found")
		return
	}
	member, found := findWorkspaceMemberByID(authCtx.Org.Members, uid)
	if !found {
		writeSCIMError(w, http.StatusNotFound, "", "user not found in workspace")
		return
	}
	if member.Role == store.WorkspaceRoleOwner {
		writeSCIMError(w, http.StatusForbidden, "mutability", "cannot deprovision workspace owner")
		return
	}

	if _, err := s.Store.UpsertWorkspaceMemberGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, member.Email, "remove"); err != nil {
		if errors.Is(err, store.ErrForbidden) {
			writeSCIMError(w, http.StatusForbidden, "mutability", "cannot deprovision workspace owner")
			return
		}
		writeSCIMError(w, http.StatusInternalServerError, "", "failed to deprovision user")
		return
	}

	s.recordAudit(authCtx.Req, authCtx.WorkspaceID, "scim.user_deprovision", "user", member.UserID, member.Email, map[string]any{
		"email": member.Email,
		"via":   "delete",
	})
	w.WriteHeader(http.StatusNoContent)
}

// --- SCIM Groups endpoints ---

// scimListGroups handles GET /scim/v2/Groups.
func (s *Server) scimListGroups(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := s.authenticateSCIM(w, r)
	if !ok {
		return
	}
	defer authCtx.Cleanup()

	filter, err := parseSCIMFilter(r.URL.Query().Get("filter"))
	if err != nil {
		writeSCIMError(w, http.StatusBadRequest, "invalidFilter", err.Error())
		return
	}
	startIndex, count, ok := parseSCIMPagination(w, r)
	if !ok {
		return
	}

	matched := make([]any, 0, len(authCtx.Org.Groups))
	for _, g := range authCtx.Org.Groups {
		if matchSCIMGroup(g, filter) {
			matched = append(matched, buildSCIMGroupResource(g))
		}
	}
	writeSCIMJSON(w, http.StatusOK, paginateSCIMItems(matched, startIndex, count))
}

// scimGetGroup handles GET /scim/v2/Groups/{gid}.
func (s *Server) scimGetGroup(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := s.authenticateSCIM(w, r)
	if !ok {
		return
	}
	defer authCtx.Cleanup()

	gid, err := strconv.ParseInt(r.PathValue("gid"), 10, 64)
	if err != nil || gid <= 0 {
		writeSCIMError(w, http.StatusNotFound, "", "group not found")
		return
	}
	grp, found := findWorkspaceGroupByID(authCtx.Org.Groups, gid)
	if !found {
		writeSCIMError(w, http.StatusNotFound, "", "group not found in workspace")
		return
	}
	writeSCIMJSON(w, http.StatusOK, buildSCIMGroupResource(grp))
}

func resolveSCIMMemberID(ref string, members []store.WorkspaceMemberInfo) (int64, bool) {
	clean := strings.TrimSpace(ref)
	if clean == "" {
		return 0, false
	}
	if id, err := strconv.ParseInt(clean, 10, 64); err == nil && id > 0 {
		if _, ok := findWorkspaceMemberByID(members, id); ok {
			return id, true
		}
		return 0, false
	}
	if m, ok := findWorkspaceMemberByEmail(members, clean); ok {
		return m.UserID, true
	}
	return 0, false
}

func parseSCIMMemberRefs(raw json.RawMessage) ([]string, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, true
	}
	var list []scimRefItem
	if err := json.Unmarshal(raw, &list); err == nil {
		out := make([]string, 0, len(list))
		for _, item := range list {
			if v := strings.TrimSpace(item.Value); v != "" {
				out = append(out, v)
			}
		}
		return out, true
	}
	var single scimRefItem
	if err := json.Unmarshal(raw, &single); err == nil && strings.TrimSpace(single.Value) != "" {
		return []string{strings.TrimSpace(single.Value)}, true
	}
	var strList []string
	if err := json.Unmarshal(raw, &strList); err == nil {
		return strList, true
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil && strings.TrimSpace(str) != "" {
		return []string{strings.TrimSpace(str)}, true
	}
	return nil, false
}

// parseSCIMMembersPathFilter extracts the target member value from an RFC 7644
// path filter such as `members[value eq "42"]`.
func parseSCIMMembersPathFilter(path string) (string, bool) {
	lower := strings.ToLower(strings.TrimSpace(path))
	if !strings.HasPrefix(lower, "members[") || !strings.HasSuffix(lower, "]") {
		return "", false
	}
	inner := strings.TrimSpace(path[len("members[") : len(path)-1])
	expr, err := parseSCIMFilter(inner)
	if err != nil || expr == nil || expr.Attr != "value" || expr.Op != "eq" {
		return "", false
	}
	return strings.TrimSpace(expr.Value), true
}

// scimCreateGroup handles POST /scim/v2/Groups.
func (s *Server) scimCreateGroup(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := s.authenticateSCIM(w, r)
	if !ok {
		return
	}
	defer authCtx.Cleanup()

	var in scimCreateGroupRequest
	if !decodeSCIMJSON(w, r, &in) {
		return
	}
	displayName := strings.TrimSpace(in.DisplayName)
	if displayName == "" {
		writeSCIMError(w, http.StatusBadRequest, "invalidValue", "displayName is required")
		return
	}

	resolvedMembers := make([]int64, 0, len(in.Members))
	seen := map[int64]bool{}
	for _, ref := range in.Members {
		uid, found := resolveSCIMMemberID(ref.Value, authCtx.Org.Members)
		if !found {
			writeSCIMError(w, http.StatusBadRequest, "invalidValue", fmt.Sprintf("group member %q is not in this workspace", ref.Value))
			return
		}
		if !seen[uid] {
			seen[uid] = true
			resolvedMembers = append(resolvedMembers, uid)
		}
	}

	grp, err := s.Store.CreateUserGroupGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, displayName, "")
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeSCIMError(w, http.StatusConflict, "invalidValue", "invalid group name")
			return
		}
		writeSCIMError(w, http.StatusInternalServerError, "", "failed to create group")
		return
	}

	for _, uid := range resolvedMembers {
		if err := s.Store.SetUserGroupMemberGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, grp.ID, uid, true); err != nil {
			writeSCIMError(w, http.StatusInternalServerError, "", "failed to add member to group")
			return
		}
	}

	refreshed, err := s.Store.GetWorkspaceOrg(r.Context(), authCtx.Guard, authCtx.WorkspaceID)
	if err == nil {
		if updated, ok := findWorkspaceGroupByID(refreshed.Groups, grp.ID); ok {
			grp = updated
		}
	}

	s.recordAudit(authCtx.Req, authCtx.WorkspaceID, "scim.group_create", "group", grp.ID, grp.Name, map[string]any{
		"displayName": grp.Name,
		"memberCount": len(grp.Members),
	})

	res := buildSCIMGroupResource(grp)
	w.Header().Set("Location", res.Meta.Location)
	writeSCIMJSON(w, http.StatusCreated, res)
}

// scimPatchGroup handles PATCH /scim/v2/Groups/{gid}.
func (s *Server) scimPatchGroup(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := s.authenticateSCIM(w, r)
	if !ok {
		return
	}
	defer authCtx.Cleanup()

	gid, err := strconv.ParseInt(r.PathValue("gid"), 10, 64)
	if err != nil || gid <= 0 {
		writeSCIMError(w, http.StatusNotFound, "", "group not found")
		return
	}
	grp, found := findWorkspaceGroupByID(authCtx.Org.Groups, gid)
	if !found {
		writeSCIMError(w, http.StatusNotFound, "", "group not found in workspace")
		return
	}

	var patch scimPatchOpRequest
	if !decodeSCIMJSON(w, r, &patch) {
		return
	}
	if len(patch.Operations) == 0 {
		writeSCIMError(w, http.StatusBadRequest, "invalidSyntax", "Operations must contain at least one patch operation")
		return
	}

	currentMembers := map[int64]bool{}
	for _, m := range grp.Members {
		currentMembers[m.UserID] = true
	}

	applyMembersOp := func(verb string, refs []string, removeAll bool) bool {
		switch verb {
		case "add":
			for _, ref := range refs {
				uid, ok := resolveSCIMMemberID(ref, authCtx.Org.Members)
				if !ok {
					writeSCIMError(w, http.StatusBadRequest, "invalidValue", fmt.Sprintf("group member %q is not in this workspace", ref))
					return false
				}
				if err := s.Store.SetUserGroupMemberGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, gid, uid, true); err != nil {
					writeSCIMError(w, http.StatusInternalServerError, "", "failed to add group member")
					return false
				}
				currentMembers[uid] = true
			}
		case "remove":
			if removeAll {
				for uid := range currentMembers {
					if err := s.Store.SetUserGroupMemberGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, gid, uid, false); err != nil {
						writeSCIMError(w, http.StatusInternalServerError, "", "failed to remove group member")
						return false
					}
					delete(currentMembers, uid)
				}
				return true
			}
			for _, ref := range refs {
				uid, ok := resolveSCIMMemberID(ref, authCtx.Org.Members)
				if !ok {
					// If numeric ID matches an existing member record, remove it; otherwise skip idempotently.
					if parsed, err := strconv.ParseInt(strings.TrimSpace(ref), 10, 64); err == nil && parsed > 0 {
						uid = parsed
					} else {
						continue
					}
				}
				if err := s.Store.SetUserGroupMemberGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, gid, uid, false); err != nil {
					writeSCIMError(w, http.StatusInternalServerError, "", "failed to remove group member")
					return false
				}
				delete(currentMembers, uid)
			}
		case "replace":
			desired := map[int64]bool{}
			for _, ref := range refs {
				uid, ok := resolveSCIMMemberID(ref, authCtx.Org.Members)
				if !ok {
					writeSCIMError(w, http.StatusBadRequest, "invalidValue", fmt.Sprintf("group member %q is not in this workspace", ref))
					return false
				}
				desired[uid] = true
			}
			for uid := range desired {
				if !currentMembers[uid] {
					if err := s.Store.SetUserGroupMemberGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, gid, uid, true); err != nil {
						writeSCIMError(w, http.StatusInternalServerError, "", "failed to add group member")
						return false
					}
					currentMembers[uid] = true
				}
			}
			for uid := range currentMembers {
				if !desired[uid] {
					if err := s.Store.SetUserGroupMemberGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, gid, uid, false); err != nil {
						writeSCIMError(w, http.StatusInternalServerError, "", "failed to remove group member")
						return false
					}
					delete(currentMembers, uid)
				}
			}
		}
		return true
	}

	applyRename := func(raw json.RawMessage) bool {
		var name string
		if err := json.Unmarshal(raw, &name); err != nil || strings.TrimSpace(name) == "" {
			writeSCIMError(w, http.StatusBadRequest, "invalidValue", "displayName must be a non-empty string")
			return false
		}
		trimmed := strings.TrimSpace(name)
		updated, err := s.Store.UpdateUserGroupGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, gid, &trimmed, nil)
		if err != nil {
			if errors.Is(err, store.ErrConflict) {
				writeSCIMError(w, http.StatusBadRequest, "invalidValue", "invalid displayName")
				return false
			}
			writeSCIMError(w, http.StatusInternalServerError, "", "failed to rename group")
			return false
		}
		grp.Name = updated.Name
		return true
	}

	for _, op := range patch.Operations {
		verb := strings.ToLower(strings.TrimSpace(op.Op))
		if verb != "replace" && verb != "add" && verb != "remove" {
			writeSCIMError(w, http.StatusBadRequest, "invalidSyntax", fmt.Sprintf("unsupported patch op %q", op.Op))
			return
		}
		pathTrim := strings.TrimSpace(op.Path)
		pathLower := strings.ToLower(pathTrim)

		switch {
		case pathLower == "displayname":
			if verb == "remove" {
				writeSCIMError(w, http.StatusBadRequest, "invalidValue", "displayName cannot be removed")
				return
			}
			if !applyRename(op.Value) {
				return
			}
		case pathLower == "members":
			refs, ok := parseSCIMMemberRefs(op.Value)
			if !ok {
				writeSCIMError(w, http.StatusBadRequest, "invalidValue", "invalid members value")
				return
			}
			removeAll := verb == "remove" && (len(op.Value) == 0 || string(op.Value) == "null")
			if !applyMembersOp(verb, refs, removeAll) {
				return
			}
		case strings.HasPrefix(pathLower, "members["):
			val, ok := parseSCIMMembersPathFilter(pathTrim)
			if !ok {
				writeSCIMError(w, http.StatusBadRequest, "invalidPath", "unsupported members filter path")
				return
			}
			if !applyMembersOp(verb, []string{val}, false) {
				return
			}
		case pathLower == "":
			if len(op.Value) == 0 {
				continue
			}
			var obj map[string]json.RawMessage
			if err := json.Unmarshal(op.Value, &obj); err != nil {
				writeSCIMError(w, http.StatusBadRequest, "invalidSyntax", "patch operation without path must provide an object value")
				return
			}
			for k, v := range obj {
				switch strings.ToLower(strings.TrimSpace(k)) {
				case "displayname":
					if !applyRename(v) {
						return
					}
				case "members":
					refs, ok := parseSCIMMemberRefs(v)
					if !ok {
						writeSCIMError(w, http.StatusBadRequest, "invalidValue", "invalid members value")
						return
					}
					if !applyMembersOp(verb, refs, false) {
						return
					}
				}
			}
		}
	}

	refreshed, err := s.Store.GetWorkspaceOrg(r.Context(), authCtx.Guard, authCtx.WorkspaceID)
	if err == nil {
		if updated, ok := findWorkspaceGroupByID(refreshed.Groups, gid); ok {
			grp = updated
		}
	}

	s.recordAudit(authCtx.Req, authCtx.WorkspaceID, "scim.group_update", "group", grp.ID, grp.Name, map[string]any{
		"displayName": grp.Name,
		"memberCount": len(grp.Members),
	})
	writeSCIMJSON(w, http.StatusOK, buildSCIMGroupResource(grp))
}

// scimDeleteGroup handles DELETE /scim/v2/Groups/{gid}.
func (s *Server) scimDeleteGroup(w http.ResponseWriter, r *http.Request) {
	authCtx, ok := s.authenticateSCIM(w, r)
	if !ok {
		return
	}
	defer authCtx.Cleanup()

	gid, err := strconv.ParseInt(r.PathValue("gid"), 10, 64)
	if err != nil || gid <= 0 {
		writeSCIMError(w, http.StatusNotFound, "", "group not found")
		return
	}
	grp, found := findWorkspaceGroupByID(authCtx.Org.Groups, gid)
	if !found {
		writeSCIMError(w, http.StatusNotFound, "", "group not found in workspace")
		return
	}

	if err := s.Store.DeleteUserGroupGuarded(r.Context(), authCtx.Guard, authCtx.WorkspaceID, gid); err != nil {
		writeSCIMError(w, http.StatusInternalServerError, "", "failed to delete group")
		return
	}

	s.recordAudit(authCtx.Req, authCtx.WorkspaceID, "scim.group_delete", "group", grp.ID, grp.Name, map[string]any{
		"displayName": grp.Name,
	})
	w.WriteHeader(http.StatusNoContent)
}
