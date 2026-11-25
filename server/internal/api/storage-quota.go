package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

// maxWorkspaceStorageQuotaBytes caps configurable workspace quotas at 1 PiB
// to guard against overflow and nonsensical inputs while remaining effectively unbounded.
const maxWorkspaceStorageQuotaBytes int64 = 1 << 50

func (s *Server) storageQuotaStore(w http.ResponseWriter) (store.StorageQuotaStore, bool) {
	st, ok := s.Store.(store.StorageQuotaStore)
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_supported", "当前存储后端暂不支持空间存储配额管理")
		return nil, false
	}
	return st, true
}

func (s *Server) requireWorkspaceAdminForStorage(w http.ResponseWriter, r *http.Request, wsID int64, forbiddenMsg string) (store.RestoreGuard, bool) {
	guard, ok := s.driveGuard(w, r)
	if !ok {
		return store.RestoreGuard{}, false
	}
	if !driveExpectedUser(w, r, guard.UserID) {
		return store.RestoreGuard{}, false
	}
	orgSnap, err := s.Store.GetWorkspaceOrg(r.Context(), guard, wsID)
	if err != nil {
		s.auditError(w, r, err)
		return store.RestoreGuard{}, false
	}
	if orgSnap.CallerRole != store.WorkspaceRoleOwner && orgSnap.CallerRole != store.WorkspaceRoleAdmin {
		httpx.Error(w, http.StatusForbidden, "forbidden", forbiddenMsg)
		return store.RestoreGuard{}, false
	}
	return guard, true
}

// enforceWorkspaceStorageQuota checks whether adding incomingBytes would exceed
// wsID's configured storage quota (0 = unlimited). When exceeded it writes a 413
// storage_quota_exceeded JSON error and returns false.
func (s *Server) enforceWorkspaceStorageQuota(ctx context.Context, w http.ResponseWriter, wsID int64, incomingBytes int64) bool {
	if s == nil || s.Store == nil || wsID <= 0 || incomingBytes <= 0 {
		return true
	}
	sqs, ok := s.Store.(store.StorageQuotaStore)
	if !ok {
		return true
	}
	usedBytes, quotaBytes, err := sqs.GetWorkspaceStorageQuota(ctx, wsID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return true
		}
		if s.Log != nil {
			s.Log.Error("workspace storage quota check failed", "wsId", wsID, "err", err)
		}
		httpx.Error(w, http.StatusInternalServerError, "internal_error", "空间存储配额校验失败")
		return false
	}
	if quotaBytes > 0 && (incomingBytes > quotaBytes || usedBytes > quotaBytes-incomingBytes) {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "storage_quota_exceeded", "空间存储配额已满，请联系管理员调整配额或清理附件")
		return false
	}
	return true
}

func formatQuotaAuditTitle(quotaBytes int64) string {
	if quotaBytes == 0 {
		return "不限制"
	}
	const (
		gib = int64(1 << 30)
		mib = int64(1 << 20)
	)
	if quotaBytes >= gib && quotaBytes%gib == 0 {
		return fmt.Sprintf("%d GB", quotaBytes/gib)
	}
	if quotaBytes >= mib && quotaBytes%mib == 0 {
		return fmt.Sprintf("%d MB", quotaBytes/mib)
	}
	return fmt.Sprintf("%d B", quotaBytes)
}

// getWorkspaceStorage handles GET /api/workspaces/{wsId}/storage.
// Requires workspace owner or admin.
func (s *Server) getWorkspaceStorage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	if _, ok := s.requireWorkspaceAdminForStorage(w, r, wsID, "仅空间所有者或管理员可查看存储空间用量"); !ok {
		return
	}
	sqs, ok := s.storageQuotaStore(w)
	if !ok {
		return
	}
	usage, err := sqs.GetWorkspaceStorageUsage(r.Context(), wsID)
	if err != nil {
		s.auditError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, usage)
}

// putWorkspaceStorageQuota handles PUT /api/workspaces/{wsId}/storage/quota.
// Requires workspace owner or admin. Body: {"quotaBytes": 1073741824} (0 = unlimited).
func (s *Server) putWorkspaceStorageQuota(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	guard, ok := s.requireWorkspaceAdminForStorage(w, r, wsID, "仅空间所有者或管理员可调整存储空间配额")
	if !ok {
		return
	}
	sqs, ok := s.storageQuotaStore(w)
	if !ok {
		return
	}
	var in struct {
		QuotaBytes *int64 `json:"quotaBytes"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.QuotaBytes == nil || *in.QuotaBytes < 0 || *in.QuotaBytes > maxWorkspaceStorageQuotaBytes {
		httpx.Error(w, http.StatusBadRequest, "invalid_quota", "存储配额无效，请输入 0（不限制）或有效正整数")
		return
	}
	quotaBytes := *in.QuotaBytes
	if err := sqs.SetWorkspaceStorageQuota(r.Context(), wsID, quotaBytes, guard.UserID, s.now().UTC()); err != nil {
		if errors.Is(err, store.ErrInvalidInput) {
			httpx.Error(w, http.StatusBadRequest, "invalid_quota", "存储配额无效，请输入 0（不限制）或有效正整数")
			return
		}
		s.auditError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "workspace.storage_quota_updated", "workspace", wsID, formatQuotaAuditTitle(quotaBytes), map[string]any{
		"quotaBytes": quotaBytes,
	})
	usage, err := sqs.GetWorkspaceStorageUsage(r.Context(), wsID)
	if err != nil {
		s.auditError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, usage)
}

// reindexWorkspaceAttachments handles POST /api/workspaces/{wsId}/attachments/reindex.
// Requires workspace owner or admin. Re-extracts text (including configured OCR) for all workspace attachments.
func (s *Server) reindexWorkspaceAttachments(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	if _, ok := s.requireWorkspaceAdminForStorage(w, r, wsID, "仅空间所有者或管理员可重建附件全文索引"); !ok {
		return
	}
	if _, ok := s.storageQuotaStore(w); !ok {
		return
	}
	if s.Blobs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "no_storage", "附件存储未配置")
		return
	}
	stats, err := ReindexAttachments(r.Context(), s.Store, s.Blobs, wsID)
	if err != nil {
		s.auditError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "workspace.attachments_reindexed", "workspace", wsID, fmt.Sprintf("重建附件索引（%d/%d）", stats.Indexed, stats.Scanned), map[string]any{
		"scanned": stats.Scanned,
		"indexed": stats.Indexed,
		"skipped": stats.Skipped,
		"failed":  stats.Failed,
	})
	httpx.JSON(w, http.StatusOK, stats)
}
