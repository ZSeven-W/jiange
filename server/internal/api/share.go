package api

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
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

func token() (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
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
	if d.Role != store.RoleManage || link.Role == "none" {
		link.Token = ""
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"members": shares, "link": link, "role": d.Role})
}

func (s *Server) putShare(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleManage)
	if !ok {
		return
	}
	var in struct {
		Email, Role string
		CreateOnly  bool `json:"createOnly"`
	}
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
	if in.CreateOnly && store.RoleRank(in.Role) == 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_role", "role must be view, edit or manage")
		return
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	err = s.Store.SetShareGuarded(r.Context(), guard, d.ID, u.ID, in.Role, in.CreateOnly)
	if errors.Is(err, store.ErrShareExists) {
		httpx.Error(w, http.StatusConflict, "already_shared", "该用户已经是协作者")
		return
	}
	if err != nil {
		s.shareMutationError(w, r, err)
		return
	}
	// A committed update may also have removed the caller's access, or a
	// concurrent revocation may prevent the follow-up read. Report the write
	// as successful even when a fresh, authorized result is unavailable.
	s.shareResultAfterMutation(w, r, guard, d.ID)
}

func (s *Server) shareResultAfterMutation(w http.ResponseWriter, r *http.Request, guard store.RestoreGuard, docID int64) {
	w.Header().Set("Cache-Control", "no-store")
	empty := func() {
		w.Header().Set("X-Share-Refresh-Required", "true")
		w.WriteHeader(http.StatusNoContent)
	}
	d, err := s.Store.GetDoc(r.Context(), guard.UserID, docID)
	if err != nil || store.RoleRank(d.Role) < store.RoleRank(store.RoleView) {
		empty()
		return
	}
	shares, err := s.Store.ListShares(r.Context(), docID)
	if err != nil {
		empty()
		return
	}
	link, err := s.Store.GetLink(r.Context(), docID)
	if err != nil {
		empty()
		return
	}
	d, err = s.Store.GetDoc(r.Context(), guard.UserID, docID)
	if err != nil || store.RoleRank(d.Role) < store.RoleRank(store.RoleView) {
		empty()
		return
	}
	user, err := s.Store.SessionUser(r.Context(), guard.SessionHash, s.now())
	if err != nil || user.ID != guard.UserID {
		empty()
		return
	}
	if d.Role != store.RoleManage || link.Role == "none" {
		link.Token = ""
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"members": shares, "link": link, "role": d.Role})
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
	if in.Role != "none" && in.Role != "anon" && in.Role != store.RoleView && in.Role != store.RoleEdit {
		httpx.Error(w, http.StatusBadRequest, "invalid_role", "link role must be none, anon, view or edit")
		return
	}

	// Use a fresh candidate with an atomic update. Reading a token and later
	// writing it back could otherwise resurrect it after a concurrent close.
	candidate := ""
	if in.Role != "none" {
		var err error
		candidate, err = token()
		if err != nil {
			s.fail(w, r, err)
			return
		}
	}
	guard, ok := s.viewGuard(w, r)
	if !ok {
		return
	}
	l, err := s.Store.ChangeLinkRoleGuarded(r.Context(), guard, d.ID, in.Role, candidate)
	if err != nil {
		s.shareMutationError(w, r, err)
		return
	}
	// The mutation is already committed. A concurrent logout or permission
	// revocation must not turn it into a failure or expose a bearer token.
	w.Header().Set("Cache-Control", "no-store")
	current, docErr := s.Store.GetDoc(r.Context(), guard.UserID, d.ID)
	user, sessionErr := s.Store.SessionUser(r.Context(), guard.SessionHash, s.now())
	if docErr != nil || current.Role != store.RoleManage || sessionErr != nil || user.ID != guard.UserID {
		w.Header().Set("X-Share-Refresh-Required", "true")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	httpx.JSON(w, http.StatusOK, l)
}

func (s *Server) shareMutationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden), errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前没有管理权限")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "share_conflict", "分享设置已变化，请重试")
	default:
		s.fail(w, r, err)
	}
}

// getPublic serves a read-only document snapshot to anyone holding the link
// token (link role must be anon). No login required.
func (s *Server) getPublic(w http.ResponseWriter, r *http.Request) {
	// Cached snapshots must not bypass a subsequent link revocation.
	w.Header().Set("Cache-Control", "no-store")
	id, role, err := s.Store.DocByToken(r.Context(), r.PathValue("token"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	if role != "anon" {
		// 非 anon 链接仍要求登录协作（走 /#/s/token），不给匿名快照
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "此链接需要登录后加入协作")
		return
	}
	d, err := s.Store.GetDocSystem(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	doc, _, err := StateAtHead(r.Context(), s.Store, id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	currentID, currentRole, err := s.Store.DocByToken(r.Context(), r.PathValue("token"))
	if errors.Is(err, store.ErrNotFound) || err == nil && (currentID != id || currentRole != "anon") {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Re-read settings after materialization so a change made while building
	// the snapshot is reflected in the public response.
	d, err = s.Store.GetDocSystem(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Metadata retrieval may block after the preceding token check. Recheck the
	// public link after it returns so revocation during that read does not
	// return the snapshot using stale authorization.
	currentID, currentRole, err = s.Store.DocByToken(r.Context(), r.PathValue("token"))
	if errors.Is(err, store.ErrNotFound) || err == nil && (currentID != id || currentRole != "anon") {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	cover, err := s.Store.DocCoverSystem(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Cover retrieval may have waited on storage. Refresh the document policy
	// afterwards so a policy change during that wait is not sent as stale.
	d, err = s.Store.GetDocSystem(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Cover retrieval may itself block; do not return its metadata or the
	// snapshot after the anonymous link is revoked during that read.
	currentID, currentRole, err = s.Store.DocByToken(r.Context(), r.PathValue("token"))
	if errors.Is(err, store.ErrNotFound) || err == nil && (currentID != id || currentRole != "anon") {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"title": d.Title, "updatedAt": d.UpdatedAt, "copyProtected": d.CopyProtected, "copyMinRole": d.CopyMinRole, "downloadMinRole": d.DownloadMinRole, "permissionsRevision": d.PermissionsRevision, "cover": cover, "view": doc.View()})
}

func (s *Server) joinLink(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	id, err := s.Store.JoinLink(r.Context(), r.PathValue("token"), u.ID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	d, err := s.Store.GetDoc(r.Context(), u.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		// The link can be closed or the document removed immediately after the
		// join transaction; report an expired link instead of a server error.
		httpx.Error(w, http.StatusNotFound, "not_found", "链接已失效")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	d = s.sanitizeWrittenDocMeta(r.Context(), u.ID, d)
	httpx.JSON(w, http.StatusOK, d)
}

func (s *Server) sharedWithMe(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	docs, err := s.Store.SharedWithMe(r.Context(), u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	docs, err = s.sanitizeDocList(r.Context(), u.ID, docs)
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
	if d.Kind == "base" && s.baseChannelAccess(r.Context(), r, d.ID, store.RoleEdit) != nil {
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限暂不支持上传附件")
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
	if d.Kind == "base" && s.baseChannelAccess(r.Context(), r, d.ID, store.RoleEdit) != nil {
		httpx.Error(w, http.StatusForbidden, "forbidden", "当前权限暂不支持上传附件")
		return
	}
	mime := hdr.Header.Get("Content-Type")
	if mime == "" {
		mime = http.DetectContentType(body)
	}
	keyToken, err := token()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	key := fmt.Sprintf("docs/%d/%s", d.ID, keyToken)
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
	// The document role can change at any time; a cached response must not
	// bypass access checks after an invitation or link is revoked.
	w.Header().Set("Cache-Control", "private, no-store")
	u, _ := UserFrom(r.Context())
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 || s.Blobs == nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "file not found")
		return
	}
	f, err := s.Store.GetFile(r.Context(), id)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "file not found")
		return
	}
	authorize := func() (bool, error) {
		meta, err := s.Store.GetDoc(r.Context(), u.ID, f.DocID)
		if err != nil {
			return false, store.ErrNotFound
		}
		if meta.Kind == "base" && s.baseChannelAccess(r.Context(), r, f.DocID, store.RoleView) != nil {
			// A file ID alone cannot establish that the caller can see the row
			// and field which contain it. Until references are projected by
			// access policy, do not serve files to restricted Base viewers.
			return false, store.ErrNotFound
		}
		requireRaster := !store.DocumentDownloadAllowed(meta, meta.Role)
		if !requireRaster {
			return false, nil
		}
		if !canInlineImage(f.Mime) {
			return false, store.ErrNotFound
		}
		visible, err := s.isProtectedImage(r, f)
		if err != nil {
			return false, err
		}
		if !visible {
			return false, store.ErrNotFound
		}
		// Resolving the current or historic image reference can involve replaying
		// a long document or reading a remote snapshot. Access can be revoked
		// while that is in progress, so check the caller again after the read.
		if _, err := s.Store.GetDoc(r.Context(), u.ID, f.DocID); err != nil {
			return false, store.ErrNotFound
		}
		return true, nil
	}
	requireRaster, err := authorize()
	if err != nil {
		s.fileAccessError(w, r, err)
		return
	}
	s.serveFileAuthorized(w, r, f, requireRaster, authorize)
}

// serveFile is called only after a document-specific authorization check.
func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, f store.FileMeta, requireRaster bool) {
	s.serveFileAuthorized(w, r, f, requireRaster, nil)
}

func (s *Server) fileAccessError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "file not found")
	} else {
		s.fail(w, r, err)
	}
}

// recheck runs after opening the blob and again immediately before response
// headers; file access and network transmission are still not transactional.
func (s *Server) serveFileAuthorized(w http.ResponseWriter, r *http.Request, f store.FileMeta, requireRaster bool, recheck func() (bool, error)) {
	rc, err := s.Blobs.Get(r.Context(), f.ObjectKey)
	if errors.Is(err, blob.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "file not found")
		return
	} else if err != nil {
		s.fail(w, r, err)
		return
	}
	defer rc.Close()
	var body io.Reader = rc
	check := func() bool {
		if recheck == nil {
			return true
		}
		restricted, err := recheck()
		if err != nil {
			s.fileAccessError(w, r, err)
			return false
		}
		requireRaster = requireRaster || restricted
		return true
	}
	if !check() {
		return
	}
	validated := false
	validate := func() bool {
		if !requireRaster || validated {
			return true
		}
		// Upload MIME metadata is supplied by the uploader. Check the bytes too,
		// otherwise a PDF masquerading as an image could bypass download limits.
		buffered := bufio.NewReader(rc)
		header, err := buffered.Peek(512)
		if err != nil && !errors.Is(err, io.EOF) {
			s.fail(w, r, err)
			return false
		}
		if !isRasterImage(header) {
			httpx.Error(w, http.StatusNotFound, "not_found", "file not found")
			return false
		}
		body = buffered
		validated = true
		return true
	}
	if !validate() || !check() || !validate() {
		return
	}
	// If the second check newly required raster validation, that read could
	// block too. Recheck once more after it, before sending response headers.
	if validated && !check() {
		return
	}
	w.Header().Set("Content-Type", f.Mime)
	w.Header().Set("Content-Length", strconv.FormatInt(f.Size, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	disp := "attachment"
	if canInlineImage(f.Mime) {
		disp = "inline"
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("%s; filename*=UTF-8''%s", disp, urlEscape(f.Name)))
	io.Copy(w, body)
}

func isRasterImage(header []byte) bool {
	if canInlineImage(http.DetectContentType(header)) {
		return true
	}
	// Go's detector does not currently recognize AVIF. Its ISO BMFF ftyp box
	// identifies AVIF through the major brand or a compatible brand.
	if len(header) < 16 || string(header[4:8]) != "ftyp" {
		return false
	}
	boxSize := uint64(header[0])<<24 | uint64(header[1])<<16 | uint64(header[2])<<8 | uint64(header[3])
	if boxSize < 16 || boxSize%4 != 0 {
		return false
	}
	end := len(header)
	if boxSize < uint64(end) {
		end = int(boxSize)
	}
	if brand := string(header[8:12]); brand == "avif" || brand == "avis" {
		return true
	}
	for i := 16; i+4 <= end; i += 4 {
		if brand := string(header[i : i+4]); brand == "avif" || brand == "avis" {
			return true
		}
	}
	return false
}

// Only browser-safe raster formats are served inline. In particular, SVG
// remains an attachment even if its MIME type has parameters or mixed case.
func canInlineImage(value string) bool {
	typ, _, err := mime.ParseMediaType(value)
	if err != nil {
		return false
	}
	switch strings.ToLower(typ) {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp":
		return true
	default:
		return false
	}
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
