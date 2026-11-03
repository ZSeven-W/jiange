package api

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const maxUpload = 20 << 20

// need loads the doc from the path and checks the caller has at least role.
func (s *Server) need(w http.ResponseWriter, r *http.Request, role string) (store.DocMeta, bool) {
	d, ok := s.docFromPath(w, r)
	if ok && store.RoleRank(d.Role) < store.RoleRank(role) {
		httpx.Error(w, http.StatusForbidden, "forbidden", "需要"+role+"权限")
		return d, false
	}
	return d, ok
}

func token() string {
	b := make([]byte, 12)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Server) getShares(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	shares, err := s.Store.ListShares(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	link, err := s.Store.GetLink(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if d.Role != store.RoleManage {
		link.Token = ""
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"members": shares, "link": link, "role": d.Role})
}

func (s *Server) putShare(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleManage)
	if !ok {
		return
	}
	var in struct{ Email, Role string }
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Role != "" && store.RoleRank(in.Role) == 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_role", "role must be view, edit or manage")
		return
	}
	u, err := s.Store.UserByEmail(r.Context(), strings.TrimSpace(in.Email))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "no_user", "没有找到该邮箱的用户")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.Store.SetShare(r.Context(), d.ID, u.ID, in.Role); err != nil {
		s.fail(w, r, err)
		return
	}
	s.getShares(w, r)
}

func (s *Server) putLink(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleManage)
	if !ok {
		return
	}
	var in struct{ Role string }
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Role != "none" && in.Role != store.RoleView && in.Role != store.RoleEdit {
		httpx.Error(w, http.StatusBadRequest, "invalid_role", "link role must be none, view or edit")
		return
	}
	l, err := s.Store.GetLink(r.Context(), d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	l.Role = in.Role
	if l.Token == "" {
		l.Token = token()
	}
	if err := s.Store.SetLink(r.Context(), d.ID, l); err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, l)
}

// joinLink grants the caller the link's role (never downgrading) and returns the doc.
func (s *Server) joinLink(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	id, role, err := s.Store.DocByToken(r.Context(), r.PathValue("token"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	if cur, err := s.Store.GetDoc(r.Context(), u.ID, id); err != nil || store.RoleRank(cur.Role) < store.RoleRank(role) {
		if err := s.Store.SetShare(r.Context(), id, u.ID, role); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	d, err := s.Store.GetDoc(r.Context(), u.ID, id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, d)
}

func (s *Server) sharedWithMe(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	docs, err := s.Store.SharedWithMe(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"docs": docs})
}

func (s *Server) uploadFile(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleEdit)
	if !ok {
		return
	}
	if s.Blobs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "no_storage", "attachments are not configured")
		return
	}
	u, _ := UserFrom(r.Context())
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+1<<20)
	f, hdr, err := r.FormFile("file")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_upload", "multipart field \"file\" required (max 20MB)")
		return
	}
	defer f.Close()
	body, err := io.ReadAll(io.LimitReader(f, maxUpload+1))
	if err != nil || len(body) > maxUpload {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large", "文件不能超过 20MB")
		return
	}
	mime := hdr.Header.Get("Content-Type")
	if mime == "" {
		mime = http.DetectContentType(body)
	}
	key := fmt.Sprintf("docs/%d/%s", d.ID, token())
	if err := s.Blobs.Put(r.Context(), key, mime, body); err != nil {
		s.fail(w, r, err)
		return
	}
	meta, err := s.Store.CreateFile(r.Context(), store.FileMeta{DocID: d.ID, UploaderID: u.ID, Name: hdr.Filename, Mime: mime, Size: int64(len(body)), ObjectKey: key})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, meta)
}

func (s *Server) getFile(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	f, err := s.Store.GetFile(r.Context(), id)
	if err == nil {
		_, err = s.Store.GetDoc(r.Context(), u.ID, f.DocID)
	}
	if err != nil || s.Blobs == nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "file not found")
		return
	}
	rc, err := s.Blobs.Get(r.Context(), f.ObjectKey)
	if errors.Is(err, blob.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "file not found")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", f.Mime)
	w.Header().Set("Content-Length", strconv.FormatInt(f.Size, 10))
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	disp := "attachment"
	if strings.HasPrefix(f.Mime, "image/") && f.Mime != "image/svg+xml" {
		disp = "inline"
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("%s; filename*=UTF-8''%s", disp, urlEscape(f.Name)))
	io.Copy(w, rc)
}

func urlEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("-._~", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
