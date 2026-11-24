package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	patTokenPrefix      = "jg_pat_"
	patRandomBytes      = 32
	patDisplayPrefixLen = 14
	patMaxExpiryDays    = 365
)

func (s *Server) patStore() (store.PATStore, bool) {
	if s == nil || s.Store == nil {
		return nil, false
	}
	ps, ok := s.Store.(store.PATStore)
	return ps, ok
}

func (s *Server) needPATStore(w http.ResponseWriter) (store.PATStore, bool) {
	ps, ok := s.patStore()
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_implemented", "当前存储不支持个人访问令牌")
		return nil, false
	}
	return ps, true
}

func generatePAT() (rawToken, prefix string, hash []byte, err error) {
	b := make([]byte, patRandomBytes)
	if _, err = rand.Read(b); err != nil {
		return "", "", nil, err
	}
	rawToken = patTokenPrefix + base64.RawURLEncoding.EncodeToString(b)
	prefix = rawToken[:patDisplayPrefixLen]
	hash = auth.HashToken(rawToken)
	return rawToken, prefix, hash, nil
}

// authenticateBearerPAT extracts and verifies an `Authorization: Bearer jg_pat_...`
// header against the Personal Access Token store, updating last_used_at on success.
func (s *Server) authenticateBearerPAT(r *http.Request) (store.User, store.PersonalAccessToken, bool) {
	if r == nil {
		return store.User{}, store.PersonalAccessToken{}, false
	}
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if authHeader == "" {
		return store.User{}, store.PersonalAccessToken{}, false
	}
	scheme, rawToken, ok := strings.Cut(authHeader, " ")
	if !ok || !strings.EqualFold(strings.TrimSpace(scheme), "Bearer") {
		return store.User{}, store.PersonalAccessToken{}, false
	}
	rawToken = strings.TrimSpace(rawToken)
	if !strings.HasPrefix(rawToken, patTokenPrefix) || len(rawToken) <= len(patTokenPrefix) {
		return store.User{}, store.PersonalAccessToken{}, false
	}
	ps, ok := s.patStore()
	if !ok {
		return store.User{}, store.PersonalAccessToken{}, false
	}
	res, err := ps.AuthenticatePersonalAccessToken(r.Context(), auth.HashToken(rawToken), s.now().UTC())
	if err != nil {
		return store.User{}, store.PersonalAccessToken{}, false
	}
	return res.User, res.Token, true
}

// patHasScope reports whether a Personal Access Token's scopes permit the given HTTP method.
// Safe read methods (GET, HEAD, OPTIONS) accept "read", "write", or "admin".
// Mutating methods require "write" or "admin".
func patHasScope(scopes []string, method string) bool {
	hasRead := false
	hasWrite := false
	for _, sc := range scopes {
		switch strings.ToLower(strings.TrimSpace(sc)) {
		case store.PATScopeRead:
			hasRead = true
		case store.PATScopeWrite, store.PATScopeAdmin:
			hasRead = true
			hasWrite = true
		}
	}
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return hasRead
	default:
		return hasWrite
	}
}

func (s *Server) patAuditWorkspaceID(ctx context.Context, userID int64) int64 {
	if s == nil || s.Store == nil || userID <= 0 {
		return 0
	}
	ws, err := s.Store.Workspaces(ctx, userID)
	if err != nil || len(ws) == 0 {
		return 0
	}
	return ws[0].ID
}

func (s *Server) listMyPATs(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	ps, ok := s.needPATStore(w)
	if !ok {
		return
	}
	tokens, err := ps.ListPersonalAccessTokens(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{"tokens": tokens})
}

func (s *Server) createMyPAT(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	ps, ok := s.needPATStore(w)
	if !ok {
		return
	}

	var in struct {
		Name          string   `json:"name"`
		Scopes        []string `json:"scopes"`
		ExpiresInDays *int     `json:"expiresInDays"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}

	name := strings.TrimSpace(in.Name)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) == 0 || utf8.RuneCountInString(name) > store.MaxPATNameRunes {
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "令牌名称需为 1-80 个字符")
		return
	}

	var scopes []string
	if in.Scopes == nil {
		scopes = []string{store.PATScopeRead, store.PATScopeWrite}
	} else {
		var valid bool
		scopes, valid = store.NormalizePATScopes(in.Scopes)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "invalid_scopes", "权限范围无效，仅支持 read、write、admin 且至少选择一项")
			return
		}
	}

	var expiresAt *time.Time
	if in.ExpiresInDays != nil {
		days := *in.ExpiresInDays
		if days < 0 || days > patMaxExpiryDays {
			httpx.Error(w, http.StatusBadRequest, "invalid_expiry", "有效期需为 1-365 天，或设为永不过期")
			return
		}
		if days > 0 {
			exp := s.now().UTC().Add(time.Duration(days) * 24 * time.Hour)
			expiresAt = &exp
		}
	}

	rawToken, prefix, hash, err := generatePAT()
	if err != nil {
		s.fail(w, r, err)
		return
	}

	tok, err := ps.CreatePersonalAccessToken(r.Context(), u.ID, name, prefix, hash, scopes, expiresAt)
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "pat_limit_reached", "最多保留 50 个有效访问令牌，请先吊销不用的令牌")
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}

	detail := map[string]any{
		"tokenId":     tok.ID,
		"tokenPrefix": tok.TokenPrefix,
		"scopes":      tok.Scopes,
	}
	if tok.ExpiresAt != nil {
		detail["expiresAt"] = tok.ExpiresAt.Format(time.RFC3339)
	}
	s.recordAudit(r, s.patAuditWorkspaceID(r.Context(), u.ID), "pat.create", "user", u.ID, tok.Name, detail)

	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"token":    tok,
		"rawToken": rawToken,
	})
}

func (s *Server) revokeMyPAT(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	ps, ok := s.needPATStore(w)
	if !ok {
		return
	}

	tid := pathID(r, "tid")
	if tid <= 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "访问令牌 ID 无效")
		return
	}

	if err := ps.RevokePersonalAccessToken(r.Context(), u.ID, tid, s.now().UTC()); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "访问令牌不存在")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}

	s.recordAudit(r, s.patAuditWorkspaceID(r.Context(), u.ID), "pat.revoke", "user", u.ID, fmt.Sprintf("PAT #%d", tid), map[string]any{
		"tokenId": tid,
	})
	w.WriteHeader(http.StatusNoContent)
}
