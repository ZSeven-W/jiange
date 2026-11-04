// Package api wires the REST endpoints (stdlib net/http routing).
package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/auth"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/btsync"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
	"github.com/ZSeven-W/jiange/server/internal/syncsrv"
)

const CookieName = "jiange_session"

type Server struct {
	Store         store.Store
	Log           *slog.Logger
	SessionTTL    time.Duration
	SecureCookies bool
	Iterations    int // PBKDF2 iterations; tests lower this
	Now           func() time.Time
	Hub           *syncsrv.Hub  // nil disables /api/sync
	BtHub         *btsync.Hub   // nil disables base realtime
	Blobs         blob.Store    // nil disables attachments
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Handler returns the full HTTP handler with middleware.
func (s *Server) Handler() http.Handler {
	if s.Iterations == 0 {
		s.Iterations = auth.DefaultIterations
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /api/auth/register", s.register)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.Handle("GET /api/me", s.requireUser(http.HandlerFunc(s.me)))
	mux.Handle("GET /api/docs", s.requireUser(http.HandlerFunc(s.listDocs)))
	mux.Handle("POST /api/docs", s.requireUser(http.HandlerFunc(s.createDoc)))
	mux.Handle("GET /api/docs/{id}", s.requireUser(http.HandlerFunc(s.getDoc)))
	mux.Handle("PATCH /api/docs/{id}", s.requireUser(http.HandlerFunc(s.patchDoc)))
	mux.Handle("DELETE /api/docs/{id}", s.requireUser(http.HandlerFunc(s.trashDoc)))
	for pat, h := range map[string]http.HandlerFunc{
		"GET /api/docs/{id}/shares":            s.getShares,
		"PUT /api/docs/{id}/shares":            s.putShare,
		"PUT /api/docs/{id}/link":              s.putLink,
		"POST /api/share/{token}":              s.joinLink,
		"GET /api/shared":                      s.sharedWithMe,
		"POST /api/docs/{id}/files":            s.uploadFile,
		"GET /api/files/{id}":                  s.getFile,
		"POST /api/bases":                      s.createBase,
		"GET /api/bases/{id}":                  s.getBase,
		"POST /api/bases/{id}/fields":          s.addField,
		"PATCH /api/bases/{id}/fields/{fid}":   s.patchField,
		"DELETE /api/bases/{id}/fields/{fid}":  s.deleteField,
		"POST /api/bases/{id}/records":         func(w http.ResponseWriter, r *http.Request) { s.writeRecord(w, r, true) },
		"PATCH /api/bases/{id}/records/{rid}":  func(w http.ResponseWriter, r *http.Request) { s.writeRecord(w, r, false) },
		"DELETE /api/bases/{id}/records/{rid}": s.deleteRecord,
	} {
		mux.Handle(pat, s.requireUser(h))
	}
	mux.Handle("GET /api/trash", s.requireUser(http.HandlerFunc(s.listTrash)))
	mux.Handle("POST /api/trash/{id}/restore", s.requireUser(http.HandlerFunc(s.restoreDoc)))
	if s.BtHub != nil {
		mux.Handle("GET /api/bases/{id}/sync", s.requireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, ok := s.needBase(w, r, store.RoleView)
			if !ok {
				return
			}
			s.BtHub.Serve(w, r, b.ID)
		})))
	}
	if s.Hub != nil {
		mux.Handle("GET /api/sync", s.requireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u, _ := UserFrom(r.Context())
			s.Hub.Serve(w, r, u)
		})))
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		httpx.Error(w, http.StatusNotFound, "not_found", "no such endpoint")
	})
	return httpx.Chain(mux,
		httpx.WithRequestID,
		httpx.Logger(s.Log),
		httpx.Recover(s.Log),
		httpx.SecurityHeaders,
		httpx.RequireJSON,
	)
}

type ctxKey int

const userKey ctxKey = 1

// UserFrom returns the authenticated user set by requireUser.
func UserFrom(ctx context.Context) (store.User, bool) {
	u, ok := ctx.Value(userKey).(store.User)
	return u, ok
}

func (s *Server) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(CookieName)
		if err != nil || c.Value == "" {
			httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
			return
		}
		u, err := s.Store.SessionUser(r.Context(), auth.HashToken(c.Value), s.now())
		if err != nil {
			httpx.Error(w, http.StatusUnauthorized, "unauthorized", "session expired")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, u)))
	})
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.Store.Ping(ctx); err != nil {
		httpx.JSON(w, http.StatusServiceUnavailable, map[string]string{"status": "db_unavailable"})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

type credentials struct {
	Email    string `json:"email"`
	Name     string `json:"name,omitempty"`
	Password string `json:"password"`
}

type meResponse struct {
	User       store.User        `json:"user"`
	Workspaces []store.Workspace `json:"workspaces"`
}

func validEmail(e string) bool {
	a, err := mail.ParseAddress(e)
	return err == nil && a.Address == e && len(e) <= 254
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !httpx.Decode(w, r, &c) {
		return
	}
	c.Email = strings.TrimSpace(c.Email)
	c.Name = strings.TrimSpace(c.Name)
	switch {
	case !validEmail(c.Email):
		httpx.Error(w, http.StatusBadRequest, "invalid_email", "invalid email")
		return
	case utf8.RuneCountInString(c.Password) < 8 || len(c.Password) > 256:
		httpx.Error(w, http.StatusBadRequest, "weak_password", "password must be 8-256 characters")
		return
	case c.Name == "" || utf8.RuneCountInString(c.Name) > 64:
		httpx.Error(w, http.StatusBadRequest, "invalid_name", "name must be 1-64 characters")
		return
	}
	hash, err := auth.HashPassword(c.Password, s.Iterations)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	u, ws, err := s.Store.CreateUser(r.Context(), c.Email, c.Name, hash)
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "email_taken", "email already registered")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !s.startSession(w, r, u.ID) {
		return
	}
	httpx.JSON(w, http.StatusCreated, meResponse{u, []store.Workspace{ws}})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !httpx.Decode(w, r, &c) {
		return
	}
	u, err := s.Store.UserByEmail(r.Context(), strings.TrimSpace(c.Email))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, err)
		return
	}
	ok := false
	if err == nil {
		ok, _ = auth.VerifyPassword(c.Password, u.PasswordHash)
	}
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "invalid_credentials", "wrong email or password")
		return
	}
	if !s.startSession(w, r, u.ID) {
		return
	}
	ws, err := s.Store.Workspaces(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, meResponse{u, ws})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(CookieName); err == nil && c.Value != "" {
		_ = s.Store.DeleteSession(r.Context(), auth.HashToken(c.Value))
	}
	http.SetCookie(w, s.cookie("", -1))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	ws, err := s.Store.Workspaces(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, meResponse{u, ws})
}

func (s *Server) cookie(val string, maxAge int) *http.Cookie {
	return &http.Cookie{Name: CookieName, Value: val, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: s.SecureCookies, SameSite: http.SameSiteLaxMode}
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, uid int64) bool {
	tok, h, err := auth.NewToken()
	if err == nil {
		err = s.Store.CreateSession(r.Context(), h, uid, s.now().Add(s.SessionTTL))
	}
	if err != nil {
		s.fail(w, r, err)
		return false
	}
	http.SetCookie(w, s.cookie(tok, int(s.SessionTTL.Seconds())))
	return true
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	s.Log.Error("request failed", "err", err, "rid", httpx.RequestID(r))
	httpx.Error(w, http.StatusInternalServerError, "internal_error", "internal error")
}
