package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/ZSeven-W/jiange/server/collab"
	"github.com/ZSeven-W/jiange/server/internal/blob"
	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

var errCopyAttachment = errors.New("source attachment unavailable")
var errCopyStorage = errors.New("attachment storage unavailable")
var errCopyProjection = errors.New("source content cannot be copied safely")

const maxCopyAttachments = 1000
const copyFilesTimeout = 60 * time.Second

type duplicateInput struct {
	Title       string          `json:"title"`
	WorkspaceID int64           `json:"workspaceId"`
	ParentID    json.RawMessage `json:"parentId"`
}

// duplicateDoc creates a complete snapshot copy in a workspace where the
// caller can create documents. A shared document is never copied into another
// organization's workspace merely because the caller can read it.
func (s *Server) duplicateDoc(w http.ResponseWriter, r *http.Request) {
	d, ok := s.need(w, r, store.RoleView)
	if !ok {
		return
	}
	if d.Kind == "base" {
		httpx.Error(w, http.StatusBadRequest, "unsupported", "多维表格暂不支持复制")
		return
	}
	if d.CopyProtected && d.Role != store.RoleManage {
		httpx.Error(w, http.StatusForbidden, "copy_protected", "文档所有者已关闭复制")
		return
	}
	var in duplicateInput
	if r.ContentLength != 0 && !httpx.Decode(w, r, &in) {
		return
	}
	if in.WorkspaceID < 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_workspace", "工作空间无效")
		return
	}
	title, valid := cleanTitle(w, in.Title)
	if !valid {
		return
	}
	u, _ := UserFrom(r.Context())
	workspaceID := in.WorkspaceID
	if workspaceID == 0 {
		can, err := s.Store.CanCreateIn(r.Context(), u.ID, d.WorkspaceID)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if can {
			workspaceID = d.WorkspaceID
		} else {
			workspaces, err := s.Store.Workspaces(r.Context(), u.ID)
			if err != nil {
				s.fail(w, r, err)
				return
			}
			if len(workspaces) == 0 {
				httpx.Error(w, http.StatusForbidden, "forbidden", "没有可创建文档的空间")
				return
			}
			// Prefer the caller's own space even if another workspace happens
			// to sort first, so a shared document is not copied into a team
			// space without an explicit destination.
			for _, workspace := range workspaces {
				if workspace.OwnerID == u.ID {
					workspaceID = workspace.ID
					break
				}
			}
			if workspaceID == 0 {
				httpx.Error(w, http.StatusConflict, "destination_required", "没有个人空间，请指定有权创建文档的目标空间")
				return
			}
		}
	}
	can, err := s.Store.CanCreateIn(r.Context(), u.ID, workspaceID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !can {
		httpx.Error(w, http.StatusForbidden, "forbidden", "无权在目标空间创建文档")
		return
	}
	var parentID *int64
	if in.ParentID != nil {
		if string(in.ParentID) != "null" {
			var id int64
			if err := json.Unmarshal(in.ParentID, &id); err != nil || id <= 0 {
				httpx.Error(w, http.StatusBadRequest, "invalid_parent", "目标位置无效")
				return
			}
			parentID = &id
		}
	} else if workspaceID == d.WorkspaceID {
		parentID = d.ParentID
	}
	if parentID != nil {
		parent, err := s.Store.GetDoc(r.Context(), u.ID, *parentID)
		if err != nil || parent.WorkspaceID != workspaceID {
			httpx.Error(w, http.StatusBadRequest, "invalid_parent", "目标位置不存在或无权访问")
			return
		}
	}

	src, _, err := StateAtHead(r.Context(), s.Store, d.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if title == "" {
		base := strings.TrimSpace(src.Text(collab.OpID{Client: 0, Clock: 1}))
		if base == "" {
			base = "未命名文档"
		}
		runes := []rune(base)
		if len(runes) > 197 {
			base = strings.TrimSpace(string(runes[:197]))
		}
		title = base + " 副本"
	}
	fileIDs, err := collectCopyFileIDs(src)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "invalid_attachment", "文档中的附件引用无效，无法创建完整副本")
		return
	}
	if len(fileIDs) > maxCopyAttachments {
		httpx.Error(w, http.StatusUnprocessableEntity, "copy_attachment_limit", "文档中的不同附件超过 1000 个，暂无法一次创建副本")
		return
	}
	if len(fileIDs) > 0 && s.Blobs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "no_storage", "附件存储未配置，无法创建完整副本")
		return
	}
	if err := s.verifyCopyFiles(r.Context(), d.ID, fileIDs); err != nil {
		if errors.Is(err, errCopyAttachment) {
			httpx.Error(w, http.StatusConflict, "invalid_attachment", "文档中的附件不可用，未创建副本")
		} else if errors.Is(err, errCopyStorage) {
			httpx.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "附件存储暂不可用，未创建副本，请稍后重试")
		} else {
			s.fail(w, r, err)
		}
		return
	}
	nd, err := s.Store.CopyDoc(r.Context(), store.DocCopy{SourceID: d.ID, UserID: u.ID, WorkspaceID: workspaceID, ParentID: parentID, Title: title, FileIDs: fileIDs}, func(ids map[int64]int64) ([]store.RawOp, error) {
		ops, err := buildCopyOps(src, title, ids)
		if err != nil {
			return nil, errors.Join(errCopyProjection, err)
		}
		return ops, nil
	})
	switch {
	case errors.Is(err, store.ErrCopyProtected):
		httpx.Error(w, http.StatusForbidden, "copy_protected", "文档所有者已关闭复制")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "无权在目标空间创建文档")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "文档或附件不存在，或已无权访问")
	case errors.Is(err, errCopyAttachment):
		httpx.Error(w, http.StatusConflict, "invalid_attachment", "文档中的附件不可用，未创建副本")
	case errors.Is(err, errCopyProjection):
		httpx.Error(w, http.StatusConflict, "copy_unavailable", "文档包含暂不支持安全复制的内容，未创建副本")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "copy_conflict", "文档状态已改变，未创建副本，请重试")
	case err != nil:
		s.fail(w, r, err)
	default:
		nd = s.sanitizeWrittenDocMeta(r.Context(), u.ID, nd)
		httpx.JSON(w, http.StatusCreated, nd)
	}
}

// Shared immutable object keys avoid copying blobs outside the database
// transaction. Verify every source object is readable before creating the
// target; future blob GC must account for all references to an object key.
func (s *Server) verifyCopyFiles(ctx context.Context, sourceID int64, ids []int64) error {
	ctx, cancelAll := context.WithTimeout(ctx, copyFilesTimeout)
	defer cancelAll()
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return errors.Join(errCopyStorage, err)
		}
		f, err := s.Store.GetFile(ctx, id)
		if errors.Is(err, store.ErrNotFound) || err == nil && (f.DocID != sourceID || f.Size < 0 || f.Size == math.MaxInt64) {
			return errCopyAttachment
		}
		if err != nil {
			if ctx.Err() != nil {
				return errors.Join(errCopyStorage, ctx.Err())
			}
			return err
		}
		fileCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		if sizer, ok := s.Blobs.(blob.Sizer); ok {
			size, sizeErr := sizer.Size(fileCtx, f.ObjectKey)
			if sizeErr == nil && size >= 0 {
				cancel()
				if size != f.Size {
					return errCopyAttachment
				}
				continue
			}
			if errors.Is(sizeErr, blob.ErrNotFound) {
				cancel()
				return errCopyAttachment
			}
			if sizeErr != nil && !errors.Is(sizeErr, blob.ErrSizeUnknown) {
				cancel()
				return errors.Join(errCopyStorage, sizeErr)
			}
		}
		r, err := s.Blobs.Get(fileCtx, f.ObjectKey)
		if errors.Is(err, blob.ErrNotFound) {
			cancel()
			return errCopyAttachment
		}
		if err != nil {
			cancel()
			return errors.Join(errCopyStorage, err)
		}
		n, readErr := io.Copy(io.Discard, io.LimitReader(r, f.Size+1))
		closeErr := r.Close()
		cancel()
		if readErr != nil || closeErr != nil {
			return errors.Join(errCopyStorage, readErr, closeErr)
		}
		if n != f.Size {
			return errCopyAttachment
		}
	}
	if err := ctx.Err(); err != nil {
		return errors.Join(errCopyStorage, err)
	}
	return nil
}
