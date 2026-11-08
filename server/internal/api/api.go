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
	Hub           *syncsrv.Hub // nil disables /api/sync
	BtHub         *btsync.Hub  // nil disables base realtime
	Blobs         blob.Store   // nil disables attachments
	WebUI         http.Handler // embedded frontend; nil serves nothing at /
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
		"GET /api/docs/{id}/shares":                         s.getShares,
		"GET /api/docs/{id}/icon":                           s.getDocIcon,
		"PUT /api/docs/{id}/icon":                           s.putDocIcon,
		"GET /api/docs/{id}/cover":                          s.getDocCover,
		"PUT /api/docs/{id}/cover":                          s.putDocCover,
		"GET /api/docs/{id}/cover/image":                    s.getDocCoverImage,
		"PUT /api/docs/{id}/shares":                         s.putShare,
		"PUT /api/docs/{id}/link":                           s.putLink,
		"POST /api/share/{token}":                           s.joinLink,
		"GET /api/shared":                                   s.sharedWithMe,
		"POST /api/docs/{id}/files":                         s.uploadFile,
		"GET /api/files/{id}":                               s.getFile,
		"DELETE /api/files/{id}":                            s.deleteFile,
		"POST /api/bases":                                   s.createBase,
		"GET /api/docs/{id}/versions":                       s.listVersions,
		"GET /api/docs/{id}/title-consistency":              s.getTitleConsistency,
		"POST /api/docs/{id}/versions":                      s.postVersion,
		"GET /api/docs/{id}/versions/{seq}":                 s.getVersion,
		"POST /api/docs/{id}/versions/{seq}/restore":        s.restoreVersion,
		"GET /api/bases/{id}":                               s.getBase,
		"POST /api/bases/{id}/fields":                       s.addField,
		"POST /api/bases/{id}/fields/reorder":               s.reorderFields,
		"PATCH /api/bases/{id}/fields/{fid}":                s.patchField,
		"DELETE /api/bases/{id}/fields/{fid}":               s.deleteField,
		"POST /api/bases/{id}/records":                      func(w http.ResponseWriter, r *http.Request) { s.mutateRecordGuarded(w, r, "add") },
		"PATCH /api/bases/{id}/records/{rid}":               func(w http.ResponseWriter, r *http.Request) { s.mutateRecordGuarded(w, r, "update") },
		"PATCH /api/bases/{id}/records/{rid}/compare-cells": s.compareDateCells,
		"PATCH /api/bases/{id}/records/{rid}/kanban-move":   s.moveKanbanCard,
		"DELETE /api/bases/{id}/records/{rid}":              func(w http.ResponseWriter, r *http.Request) { s.mutateRecordGuarded(w, r, "delete") },
		"POST /api/bases/{id}/views":                        s.addView,
		"POST /api/bases/{id}/views/{vid}/duplicate":        s.duplicateView,
		"POST /api/bases/{id}/views/{vid}/rename":           s.renameView,
		"POST /api/bases/{id}/views/reorder":                s.reorderViews,
		"PATCH /api/bases/{id}/views/{vid}":                 s.patchView,
		"DELETE /api/bases/{id}/views/{vid}":                s.deleteView,
		"GET /api/bases/{id}/views/{vid}/public-form":       s.publicFormStatus,
		"POST /api/bases/{id}/views/{vid}/public-form":      s.publishPublicForm,
		"DELETE /api/bases/{id}/views/{vid}/public-form":    s.closePublicForm,
		"POST /api/bases/{id}/views/{vid}/form-config":      s.savePublicFormConfig,
		"POST /api/bases/{id}/query":                        s.queryBase,
		"GET /api/bases/{id}/automations":                   s.listAutomations,
		"POST /api/bases/{id}/automations":                  s.addAutomation,
		"PATCH /api/bases/{id}/automations/{aid}":           s.patchAutomation,
		"DELETE /api/bases/{id}/automations/{aid}":          s.deleteAutomation,
		"POST /api/bases/{id}/import":                       s.importCSV,
		"GET /api/bases/{id}/export":                        s.exportCSV,
		"GET /api/docs/{id}/comments":                       s.listComments,
		"POST /api/docs/{id}/comments":                      s.addComment,
		"GET /api/docs/{id}/comment-attempts/capabilities":  s.commentAttemptCapabilities,
		"POST /api/docs/{id}/comment-attempts":              s.addCommentAttempt,
		"GET /api/docs/{id}/comment-attempts/{mutationId}":  s.getCommentAttempt,
		"PATCH /api/docs/{id}/comments/{cid}":               s.patchComment,
		"DELETE /api/docs/{id}/comments/{cid}":              s.deleteComment,
		"POST /api/docs/{id}/duplicate":                     s.duplicateDoc,
		"GET /api/docs/{id}/members":                        s.docMembers,
		"GET /api/notifications":                            s.listNotifications,
		"POST /api/notifications/read":                      s.markNotificationsRead,
		"POST /api/drive/files":                             s.postDriveFile,
		"GET /api/drive/files/{id}":                         s.getDriveFile,
		"POST /api/drive/folders":                           s.postDriveFolder,
		"POST /api/drive/nodes":                             s.postDriveNode,
		"GET /api/drive/children":                           s.listDriveChildren,
		"POST /api/drive/move/{id}":                         s.postDriveMove,
		"POST /api/drive/trash/{id}":                        s.postDriveTrash,
		"POST /api/drive/restore/{id}":                      s.postDriveRestore,
		"POST /api/drive/purge/{id}":                        s.postDrivePurge,
		"POST /api/drive/rename/{id}":                       s.postDriveRename,
		"POST /api/slides/{id}/pages":                       s.postSlidesPage,
		"GET /api/slides/{id}/pages":                        s.listSlidesPages,
		"PATCH /api/slides/pages/{pid}":                     s.patchSlidesPage,
		"DELETE /api/slides/pages/{pid}":                    s.deleteSlidesPage,
		"POST /api/slides/pages/{pid}/move":                 s.moveSlidesPage,
		"GET /api/search":                                   s.searchDocs,
		"GET /api/favorites":                                s.listFavorites,
		"GET /api/recent":                                   s.listRecent,
		"POST /api/docs/{id}/visit":                         s.recordVisit,
		"PUT /api/docs/{id}/star":                           s.putFavorite,
		"DELETE /api/docs/{id}/star":                        s.putFavorite,
		"GET /api/docs/{id}/ancestors":                      s.getAncestors,
	} {
		mux.Handle(pat, s.requireUser(h))
	}
	mux.Handle("GET /api/public/{token}", http.HandlerFunc(s.getPublic))
	mux.Handle("GET /api/public/{token}/cover/image", http.HandlerFunc(s.getPublicCoverImage))
	mux.Handle("GET /api/public/{token}/files/{id}", http.HandlerFunc(s.getPublicFile))
	// public form endpoints (anonymous visitors)
	mux.Handle("GET /api/forms/{id}/{vid}", http.HandlerFunc(s.legacyPublicForm))
	mux.Handle("POST /api/forms/{id}/{vid}", http.HandlerFunc(s.legacyPublicForm))
	mux.Handle("GET /api/forms/{token}", http.HandlerFunc(s.getForm))
	mux.Handle("POST /api/forms/{token}", http.HandlerFunc(s.submitForm))
	mux.Handle("GET /api/trash", s.requireUser(http.HandlerFunc(s.listTrash)))
	mux.Handle("POST /api/trash/{id}/restore", s.requireUser(http.HandlerFunc(s.restoreDoc)))
	if s.BtHub != nil {
		mux.Handle("GET /api/bases/{id}/sync", s.requireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, ok := s.needBase(w, r, store.RoleView)
			if !ok {
				return
			}
			check := func(ctx context.Context) error {
				return s.baseChannelAccess(ctx, r, b.ID, store.RoleView)
			}
			// Events carry raw records, so restricted users must not connect until
			// per-recipient event projection is implemented.
			if err := check(r.Context()); err != nil {
				httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限暂不支持实时同步")
				return
			}
			s.BtHub.Serve(w, r, b.ID, check)
		})))
	}
	if s.Hub != nil {
		mux.Handle("GET /api/sync", s.requireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u, _ := UserFrom(r.Context())
			cookie, err := r.Cookie(CookieName)
			if err != nil || cookie.Value == "" {
				httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
				return
			}
			// Keep only the token hash in the connection callback, and recheck
			// that same session as well as document permission on every frame.
			sessionHash := auth.HashToken(cookie.Value)
			s.Hub.Serve(w, r, u, func(ctx context.Context) error {
				current, err := s.Store.SessionUser(ctx, sessionHash, s.now())
				if err != nil {
					return err
				}
				if current.ID != u.ID {
					return store.ErrNotFound
				}
				return nil
			})
		})))
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		httpx.Error(w, http.StatusNotFound, "not_found", "no such endpoint")
	})
	if s.WebUI != nil {
		mux.Handle("/", s.WebUI)
	}
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
