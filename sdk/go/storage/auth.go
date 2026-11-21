package storage

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// Action represents a document permission level.
type Action string

const (
	ActionRead  Action = "read"
	ActionWrite Action = "write"
	ActionAdmin Action = "admin"
)

var (
	// ErrUnauthenticated is returned when request credentials are missing or invalid.
	ErrUnauthenticated = errors.New("storage: unauthenticated")
	// ErrForbidden is returned when a principal lacks permission for an action.
	ErrForbidden = errors.New("storage: forbidden")
)

// Principal describes an authenticated caller identity.
type Principal struct {
	ID       string            `json:"id"`
	Name     string            `json:"name,omitempty"`
	Roles    []string          `json:"roles,omitempty"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

type principalContextKey struct{}

// WithPrincipal attaches a Principal to ctx.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, principalContextKey{}, p)
}

// PrincipalFromContext retrieves the Principal previously stored in ctx.
func PrincipalFromContext(ctx context.Context) (*Principal, bool) {
	p, ok := ctx.Value(principalContextKey{}).(*Principal)
	return p, ok && p != nil
}

// Authenticator extracts and validates caller credentials from an HTTP request.
type Authenticator interface {
	Authenticate(r *http.Request) (*Principal, error)
}

// Authorizer determines whether a principal may perform action on docID.
type Authorizer interface {
	Authorize(ctx context.Context, p *Principal, docID string, action Action) error
}

// BearerTokenAuth authenticates requests using static Bearer tokens with constant-time comparison.
type BearerTokenAuth struct {
	tokens map[string]Principal
}

// NewBearerTokenAuth constructs a BearerTokenAuth with a token-to-Principal mapping.
func NewBearerTokenAuth(tokens map[string]Principal) *BearerTokenAuth {
	cp := make(map[string]Principal, len(tokens))
	for k, v := range tokens {
		cp[k] = v
	}
	return &BearerTokenAuth{tokens: cp}
}

// Authenticate validates the Authorization: Bearer <token> header.
func (b *BearerTokenAuth) Authenticate(r *http.Request) (*Principal, error) {
	hdr := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(hdr) < 7 || !strings.EqualFold(hdr[:7], "Bearer ") {
		return nil, ErrUnauthenticated
	}
	provided := strings.TrimSpace(hdr[7:])
	for tok, principal := range b.tokens {
		if subtle.ConstantTimeCompare([]byte(tok), []byte(provided)) == 1 {
			cp := principal
			cp.Roles = append([]string(nil), principal.Roles...)
			if principal.Metadata != nil {
				cp.Metadata = make(map[string]string, len(principal.Metadata))
				for mk, mv := range principal.Metadata {
					cp.Metadata[mk] = mv
				}
			}
			return &cp, nil
		}
	}
	return nil, ErrUnauthenticated
}

// AllowAllAuthorizer permits every action for any caller.
type AllowAllAuthorizer struct{}

// Authorize always succeeds.
func (AllowAllAuthorizer) Authorize(_ context.Context, _ *Principal, _ string, _ Action) error {
	return nil
}

// RoleAuthorizer checks whether a principal possesses an allowed role for the requested action.
type RoleAuthorizer struct {
	allowed map[Action]map[string]bool
}

// NewRoleAuthorizer constructs a RoleAuthorizer. When actionRoles is nil, default RBAC rules
// (viewer/editor/admin for read, editor/admin for write, admin for admin) are used.
func NewRoleAuthorizer(actionRoles map[Action][]string) *RoleAuthorizer {
	if actionRoles == nil {
		actionRoles = map[Action][]string{
			ActionRead:  {"viewer", "editor", "admin"},
			ActionWrite: {"editor", "admin"},
			ActionAdmin: {"admin"},
		}
	}
	allowed := make(map[Action]map[string]bool, len(actionRoles))
	for act, roles := range actionRoles {
		set := make(map[string]bool, len(roles))
		for _, role := range roles {
			set[strings.ToLower(strings.TrimSpace(role))] = true
		}
		allowed[act] = set
	}
	return &RoleAuthorizer{allowed: allowed}
}

// Authorize returns nil if p has at least one role allowed for action.
func (ra *RoleAuthorizer) Authorize(_ context.Context, p *Principal, _ string, action Action) error {
	if p == nil {
		return ErrForbidden
	}
	set := ra.allowed[action]
	for _, r := range p.Roles {
		if set[strings.ToLower(strings.TrimSpace(r))] {
			return nil
		}
	}
	return ErrForbidden
}

// AuthMiddleware wraps next with optional authentication and authorization checks.
func AuthMiddleware(
	auth Authenticator,
	authz Authorizer,
	docIDFromReq func(*http.Request) string,
	action Action,
	next http.Handler,
) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var principal *Principal
		if auth != nil {
			p, err := auth.Authenticate(r)
			if err != nil {
				writeAuthError(w, http.StatusUnauthorized, err.Error())
				return
			}
			principal = p
			r = r.WithContext(WithPrincipal(r.Context(), p))
		} else if existing, ok := PrincipalFromContext(r.Context()); ok {
			principal = existing
		}
		if authz != nil {
			docID := ""
			if docIDFromReq != nil {
				docID = docIDFromReq(r)
			}
			if err := authz.Authorize(r.Context(), principal, docID, action); err != nil {
				writeAuthError(w, http.StatusForbidden, err.Error())
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeAuthError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
