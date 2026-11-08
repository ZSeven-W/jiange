package api

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// postDriveFile stores the bytes first and publishes their node and reference
// together. An uncertain database result deliberately leaves the object for a
// future orphan sweep: deleting it could corrupt a committed node.
func (s *Server) postDriveFile(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	g, ok := s.driveGuard(w, r)
	if !ok {
		return
	}
	if s.Blobs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "no_storage", "云盘文件存储未配置")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+(1<<20))
	if err := r.ParseMultipartForm(maxUpload + (1 << 20)); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_upload", "请选择不超过 20 MB 的文件")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	f, h, err := r.FormFile("file")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_upload", "请选择文件")
		return
	}
	defer f.Close()
	name := strings.TrimSpace(h.Filename)
	if !store.ValidDriveFileName(name) {
		httpx.Error(w, http.StatusBadRequest, "invalid_title", "文件名无效或超过 100 字")
		return
	}
	var parent *int64
	if raw := r.FormValue("parentId"); raw != "" {
		id, e := strconv.ParseInt(raw, 10, 64)
		if e != nil || id <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_parent", "目录无效")
			return
		}
		parent = &id
	}
	var wsID int64
	if raw := r.FormValue("workspaceId"); raw != "" {
		wsID, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || wsID <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_workspace", "空间无效")
			return
		}
	} else if parent != nil {
		folder, e := s.Store.GetDoc(r.Context(), u.ID, *parent)
		if e != nil || folder.Kind != "folder" {
			httpx.Error(w, http.StatusNotFound, "not_found", "目录不存在")
			return
		}
		wsID = folder.WorkspaceID
	} else {
		spaces, e := s.Store.Workspaces(r.Context(), u.ID)
		if e != nil || len(spaces) == 0 {
			if e == nil {
				httpx.Error(w, http.StatusForbidden, "forbidden", "没有可用空间")
			} else {
				s.fail(w, r, e)
			}
			return
		}
		wsID = spaces[0].ID
	}
	if parent != nil {
		folder, e := s.Store.GetDoc(r.Context(), u.ID, *parent)
		if e != nil || folder.Kind != "folder" || folder.WorkspaceID != wsID {
			httpx.Error(w, http.StatusNotFound, "not_found", "目录不存在")
			return
		}
		if store.RoleRank(folder.Role) < store.RoleRank(store.RoleEdit) {
			httpx.Error(w, http.StatusForbidden, "forbidden", "没有在该目录上传的权限")
			return
		}
	}
	scope := r.FormValue("scope")
	if scope != "" && scope != "personal" && scope != "shared" {
		httpx.Error(w, http.StatusBadRequest, "invalid_scope", "空间类型无效")
		return
	}
	body, err := io.ReadAll(io.LimitReader(f, maxUpload+1))
	if err != nil || len(body) > maxUpload {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large", "文件不能超过 20 MB")
		return
	}
	mime := http.DetectContentType(body)
	keyToken, err := token()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	key := fmt.Sprintf("drive/%d/%s", wsID, keyToken)
	if err = s.Blobs.Put(r.Context(), key, mime, body); err != nil {
		s.fail(w, r, err)
		return
	}
	entry, err := s.Store.CreateDriveFile(r.Context(), g, wsID, parent, store.FileMeta{Name: name, Mime: mime, Size: int64(len(body)), ObjectKey: key}, scope == "personal")
	if err != nil {
		s.Log.Warn("drive upload may have left an unreferenced object", "key", key, "error", err)
		if driveWriteErr(w, err, "upload file") {
			return
		}
		return
	}
	httpx.JSON(w, http.StatusCreated, entry)
}

func (s *Server) getDriveFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	u, _ := UserFrom(r.Context())
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Error(w, http.StatusNotFound, "not_found", "文件不存在")
		return
	}
	f, err := s.Store.GetDriveFile(r.Context(), u.ID, id)
	if err != nil {
		if driveWriteErr(w, err, "get drive file") {
			return
		}
		return
	}
	httpx.JSON(w, http.StatusOK, f)
}
