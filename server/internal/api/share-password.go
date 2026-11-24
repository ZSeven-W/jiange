package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	minLinkPasswordRunes = 4
	maxLinkPasswordRunes = 32
	linkPassCookieMaxAge = 86400
)

var errLinkPasswordRequired = errors.New("api: share link password required")

type linkWithPassword struct {
	store.Link
	HasPassword bool `json:"hasPassword"`
}

func (s *Server) passwordIterations() int {
	if s != nil && s.Iterations > 0 {
		return s.Iterations
	}
	return auth.DefaultIterations
}

func normalizeLinkPassword(raw string) (string, bool) {
	pass := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(pass)
	if n < minLinkPasswordRunes || n > maxLinkPasswordRunes {
		return "", false
	}
	for _, r := range pass {
		if !unicode.IsPrint(r) {
			return "", false
		}
	}
	return pass, true
}

func (s *Server) linkPassSecret() []byte {
	if s != nil && len(s.AISecret) > 0 {
		mac := hmac.New(sha256.New, s.AISecret)
		mac.Write([]byte("jiange-link-password-v1"))
		return mac.Sum(nil)
	}
	return []byte("jiange-dev-link-pass")
}

func linkPassCookieName(token string) string {
	sum := sha256.Sum256([]byte(token))
	return "jiange_lp_" + hex.EncodeToString(sum[:])[:12]
}

func linkPassHashPrefix(passwordHash string) string {
	sum := sha256.Sum256([]byte(passwordHash))
	return hex.EncodeToString(sum[:])[:16]
}

func (s *Server) signLinkPassToken(docID int64, token, passwordHash string) string {
	mac := hmac.New(sha256.New, s.linkPassSecret())
	fmt.Fprintf(mac, "%d:%s:%s", docID, token, linkPassHashPrefix(passwordHash))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) linkPassCookie(docID int64, token, passwordHash string) *http.Cookie {
	return &http.Cookie{
		Name:     linkPassCookieName(token),
		Value:    s.signLinkPassToken(docID, token, passwordHash),
		Path:     "/",
		MaxAge:   linkPassCookieMaxAge,
		HttpOnly: true,
		Secure:   s.SecureCookies,
		SameSite: http.SameSiteLaxMode,
	}
}

func (s *Server) hasValidLinkPassword(r *http.Request, docID int64, token, passwordHash string) bool {
	if passwordHash == "" {
		return true
	}
	if r == nil {
		return false
	}
	if c, err := r.Cookie(linkPassCookieName(token)); err == nil && c.Value != "" {
		expected := s.signLinkPassToken(docID, token, passwordHash)
		if subtle.ConstantTimeCompare([]byte(c.Value), []byte(expected)) == 1 {
			return true
		}
	}
	if hdr := strings.TrimSpace(r.Header.Get("X-Share-Password")); hdr != "" {
		if ok, err := auth.VerifyPassword(hdr, passwordHash); err == nil && ok {
			return true
		}
	}
	return false
}

func (s *Server) getLinkPasswordHash(ctx context.Context, docID int64) (string, error) {
	st, ok := s.Store.(store.SharePasswordStore)
	if !ok {
		return "", nil
	}
	return st.GetLinkPasswordHash(ctx, docID)
}

func (s *Server) clearLinkPasswordBestEffort(ctx context.Context, guard store.RestoreGuard, docID int64) {
	st, ok := s.Store.(store.SharePasswordStore)
	if !ok {
		return
	}
	_ = st.SetLinkPasswordGuarded(ctx, guard, docID, "")
}

func (s *Server) requireLinkPassword(w http.ResponseWriter, r *http.Request, docID int64, token string) bool {
	hash, err := s.getLinkPasswordHash(r.Context(), docID)
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	if hash == "" {
		return true
	}
	if !s.hasValidLinkPassword(r, docID, token, hash) {
		httpx.Error(w, http.StatusForbidden, "password_required", "此分享链接已加密，请输入访问密码")
		return false
	}
	return true
}

func (s *Server) checkLinkPasswordError(r *http.Request, docID int64, token string) error {
	hash, err := s.getLinkPasswordHash(r.Context(), docID)
	if err != nil {
		return err
	}
	if hash != "" && !s.hasValidLinkPassword(r, docID, token, hash) {
		return errLinkPasswordRequired
	}
	return nil
}

// requireJoinLinkPassword checks the share link's access password before join.
// For workspace-only links, non-members receive 404 without confirming whether
// a password is set.
func (s *Server) requireJoinLinkPassword(w http.ResponseWriter, r *http.Request, userID int64, tok, notFoundMsg string) bool {
	docID, linkRole, err := s.Store.DocByToken(r.Context(), tok)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", notFoundMsg)
		return false
	}
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	if linkRole == store.LinkWorkspaceView || linkRole == store.LinkWorkspaceEdit {
		dm, gErr := s.Store.GetDocSystem(r.Context(), docID)
		if errors.Is(gErr, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", notFoundMsg)
			return false
		}
		if gErr != nil {
			s.fail(w, r, gErr)
			return false
		}
		member, mErr := s.Store.CanCreateIn(r.Context(), userID, dm.WorkspaceID)
		if mErr != nil {
			s.fail(w, r, mErr)
			return false
		}
		if !member {
			httpx.Error(w, http.StatusNotFound, "not_found", notFoundMsg)
			return false
		}
	}
	return s.requireLinkPassword(w, r, docID, tok)
}

// putLinkPassword sets or clears a document's share link access password.
// Route: PUT /api/docs/{id}/link-password (behind s.requireUser).
func (s *Server) putLinkPassword(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	d, ok := s.need(w, r, store.RoleManage)
	if !ok {
		return
	}
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return
	}
	var in struct {
		Password string `json:"password"`
		Clear    bool   `json:"clear"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	st, ok := s.Store.(store.SharePasswordStore)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "unavailable", "服务暂不支持设置访问密码")
		return
	}
	var hash string
	if !in.Clear {
		pass, valid := normalizeLinkPassword(in.Password)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "invalid_password", "访问密码需为 4–32 位可打印字符")
			return
		}
		var err error
		hash, err = auth.HashPassword(pass, s.passwordIterations())
		if err != nil {
			s.fail(w, r, err)
			return
		}
	}
	if err := st.SetLinkPasswordGuarded(r.Context(), guard, d.ID, hash); err != nil {
		s.shareMutationError(w, r, err)
		return
	}
	s.recordAudit(r, d.WorkspaceID, "share.link_update", d.Kind, d.ID, d.Title, map[string]any{"hasPassword": !in.Clear})
	httpx.JSON(w, http.StatusOK, map[string]any{"hasPassword": !in.Clear})
}

// verifyPublicLinkPassword checks the access password for a share token and
// issues a signed HttpOnly cookie when valid.
// Route: POST /api/public/{token}/verify-password (anonymous public route).
func (s *Server) verifyPublicLinkPassword(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	tok := r.PathValue("token")
	docID, _, err := s.Store.DocByToken(r.Context(), tok)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	hash, err := s.getLinkPasswordHash(r.Context(), docID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if hash == "" {
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	pass := strings.TrimSpace(in.Password)
	matched, err := auth.VerifyPassword(pass, hash)
	if err != nil || !matched {
		httpx.Error(w, http.StatusForbidden, "invalid_password", "访问密码错误")
		return
	}
	http.SetCookie(w, s.linkPassCookie(docID, tok, hash))
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
