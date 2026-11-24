package api

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

func extractClientIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		first = strings.TrimSpace(first)
		if first != "" {
			if host, _, err := net.SplitHostPort(first); err == nil && host != "" {
				return host
			}
			return strings.Trim(first, "[]")
		}
	}
	raw := strings.TrimSpace(r.RemoteAddr)
	if raw == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(raw); err == nil && host != "" {
		return host
	}
	return strings.Trim(raw, "[]")
}

func marshalAuditDetail(detail map[string]any) json.RawMessage {
	if len(detail) == 0 {
		return json.RawMessage("{}")
	}
	b, err := json.Marshal(detail)
	if err != nil || len(b) == 0 {
		return json.RawMessage("{}")
	}
	return json.RawMessage(b)
}

// recordAudit safely appends a workspace security audit event for the current
// authenticated request without ever failing the parent operation.
func (s *Server) recordAudit(r *http.Request, wsID int64, action, resourceType string, resourceID int64, resourceTitle string, detail map[string]any) {
	if s == nil || s.Store == nil {
		return
	}
	auditStore, ok := s.Store.(store.AuditLogStore)
	if !ok {
		return
	}
	var (
		ctx        = context.Background()
		actorID    int64
		actorName  string
		actorEmail string
		userAgent  string
	)
	if r != nil {
		ctx = r.Context()
		if u, hasUser := UserFrom(ctx); hasUser {
			actorID = u.ID
			actorName = u.Name
			actorEmail = u.Email
		}
		userAgent = r.UserAgent()
	}
	entry := store.AuditLogEntry{
		WorkspaceID:   wsID,
		ActorID:       actorID,
		ActorName:     actorName,
		ActorEmail:    actorEmail,
		Action:        action,
		ResourceType:  resourceType,
		ResourceID:    resourceID,
		ResourceTitle: resourceTitle,
		Detail:        marshalAuditDetail(detail),
		IPAddress:     extractClientIP(r),
		UserAgent:     userAgent,
		CreatedAt:     s.now().UTC(),
	}
	if err := auditStore.AppendAuditLog(ctx, entry); err != nil && s.Log != nil {
		s.Log.Warn("append audit log failed", "action", action, "wsId", wsID, "err", err)
	}
}

// recordAuthAudit records authentication lifecycle events (login, SSO login,
// logout) where UserFrom(r.Context()) may not be populated yet.
func (s *Server) recordAuthAudit(r *http.Request, wsID int64, actorID int64, actorName, actorEmail, action string, detail map[string]any) {
	if s == nil || s.Store == nil {
		return
	}
	auditStore, ok := s.Store.(store.AuditLogStore)
	if !ok {
		return
	}
	ctx := context.Background()
	userAgent := ""
	if r != nil {
		ctx = r.Context()
		userAgent = r.UserAgent()
	}
	entry := store.AuditLogEntry{
		WorkspaceID:   wsID,
		ActorID:       actorID,
		ActorName:     actorName,
		ActorEmail:    actorEmail,
		Action:        action,
		ResourceType:  "auth",
		ResourceID:    actorID,
		ResourceTitle: actorEmail,
		Detail:        marshalAuditDetail(detail),
		IPAddress:     extractClientIP(r),
		UserAgent:     userAgent,
		CreatedAt:     s.now().UTC(),
	}
	if err := auditStore.AppendAuditLog(ctx, entry); err != nil && s.Log != nil {
		s.Log.Warn("append auth audit log failed", "action", action, "wsId", wsID, "err", err)
	}
}

func (s *Server) auditLogStore(w http.ResponseWriter) (store.AuditLogStore, bool) {
	as, ok := s.Store.(store.AuditLogStore)
	if !ok {
		httpx.Error(w, http.StatusNotImplemented, "not_implemented", "当前存储不支持审计日志与安全策略")
		return nil, false
	}
	return as, true
}

func (s *Server) auditError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrUnauthenticated):
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "登录状态已失效")
	case errors.Is(err, store.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "forbidden", "没有安全审计或策略管理权限")
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "目标空间不存在")
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "audit_conflict", "参数无效或存在冲突")
	default:
		s.fail(w, r, err)
	}
}

func parseAuditTimestamp(raw string, endOfDay bool) (*time.Time, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, true
	}
	if t, err := time.Parse(time.RFC3339Nano, trimmed); err == nil {
		u := t.UTC()
		return &u, true
	}
	if t, err := time.Parse(time.RFC3339, trimmed); err == nil {
		u := t.UTC()
		return &u, true
	}
	if t, err := time.Parse("2006-01-02", trimmed); err == nil {
		u := t.UTC()
		if endOfDay {
			u = u.Add(24*time.Hour - time.Nanosecond)
		}
		return &u, true
	}
	return nil, false
}

func parseAuditFilterQuery(w http.ResponseWriter, r *http.Request, wsID int64, forExport bool) (store.AuditLogFilter, bool) {
	q := r.URL.Query()
	filter := store.AuditLogFilter{
		WorkspaceID:  wsID,
		Action:       strings.TrimSpace(q.Get("action")),
		ResourceType: strings.TrimSpace(q.Get("resourceType")),
		Query:        strings.TrimSpace(q.Get("q")),
		Export:       forExport,
	}
	if rawActor := strings.TrimSpace(q.Get("actorId")); rawActor != "" {
		id, err := strconv.ParseInt(rawActor, 10, 64)
		if err != nil || id <= 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_actor_id", "actorId must be a positive integer")
			return store.AuditLogFilter{}, false
		}
		filter.ActorID = id
	}
	fromTime, ok := parseAuditTimestamp(q.Get("from"), false)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_from", "from must be RFC3339 or YYYY-MM-DD")
		return store.AuditLogFilter{}, false
	}
	filter.From = fromTime
	toTime, ok := parseAuditTimestamp(q.Get("to"), true)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid_to", "to must be RFC3339 or YYYY-MM-DD")
		return store.AuditLogFilter{}, false
	}
	filter.To = toTime

	if forExport {
		filter.Limit = store.AuditLogExportLimit
		filter.Offset = 0
		return filter, true
	}

	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		v, err := strconv.Atoi(rawLimit)
		if err != nil || v < 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_limit", "limit must be a non-negative integer")
			return store.AuditLogFilter{}, false
		}
		filter.Limit = v
	}
	if rawOffset := strings.TrimSpace(q.Get("offset")); rawOffset != "" {
		v, err := strconv.Atoi(rawOffset)
		if err != nil || v < 0 {
			httpx.Error(w, http.StatusBadRequest, "invalid_offset", "offset must be a non-negative integer")
			return store.AuditLogFilter{}, false
		}
		filter.Offset = v
	}
	return filter, true
}

// sanitizeAuditCSVCell neutralizes spreadsheet formula injection (CSV/Excel/Sheets)
// by prefixing dangerous leading characters with a single quote.
func sanitizeAuditCSVCell(s string) string {
	if s == "" {
		return ""
	}
	first := s[0]
	if first == '=' || first == '+' || first == '-' || first == '@' || first == '\t' || first == '\r' {
		return "'" + s
	}
	trimmed := strings.TrimLeft(s, " \t\r\n")
	if trimmed != "" {
		c := trimmed[0]
		if c == '=' || c == '+' || c == '-' || c == '@' {
			return "'" + s
		}
	}
	return s
}

// listWorkspaceAuditLogs handles GET /api/workspaces/{wsId}/audit-logs.
func (s *Server) listWorkspaceAuditLogs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
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
	auditStore, ok := s.auditLogStore(w)
	if !ok {
		return
	}
	filter, ok := parseAuditFilterQuery(w, r, wsID, false)
	if !ok {
		return
	}
	page, err := auditStore.ListAuditLogsGuarded(r.Context(), guard, wsID, filter)
	if err != nil {
		s.auditError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, page)
}

// exportWorkspaceAuditLogs handles GET /api/workspaces/{wsId}/audit-logs/export.
func (s *Server) exportWorkspaceAuditLogs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
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
	auditStore, ok := s.auditLogStore(w)
	if !ok {
		return
	}
	filter, ok := parseAuditFilterQuery(w, r, wsID, true)
	if !ok {
		return
	}
	page, err := auditStore.ListAuditLogsGuarded(r.Context(), guard, wsID, filter)
	if err != nil {
		s.auditError(w, r, err)
		return
	}

	var buf bytes.Buffer
	// UTF-8 BOM so Excel opens Chinese characters cleanly without mojibake.
	buf.Write([]byte{0xEF, 0xBB, 0xBF})
	wr := csv.NewWriter(&buf)
	_ = wr.Write([]string{
		"id",
		"created_at",
		"actor_id",
		"actor_name",
		"actor_email",
		"action",
		"resource_type",
		"resource_id",
		"resource_title",
		"ip_address",
		"user_agent",
		"detail",
	})
	for _, item := range page.Items {
		_ = wr.Write([]string{
			strconv.FormatInt(item.ID, 10),
			item.CreatedAt.UTC().Format(time.RFC3339),
			strconv.FormatInt(item.ActorID, 10),
			sanitizeAuditCSVCell(item.ActorName),
			sanitizeAuditCSVCell(item.ActorEmail),
			sanitizeAuditCSVCell(item.Action),
			sanitizeAuditCSVCell(item.ResourceType),
			strconv.FormatInt(item.ResourceID, 10),
			sanitizeAuditCSVCell(item.ResourceTitle),
			sanitizeAuditCSVCell(item.IPAddress),
			sanitizeAuditCSVCell(item.UserAgent),
			sanitizeAuditCSVCell(string(item.Detail)),
		})
	}
	wr.Flush()
	if err := wr.Error(); err != nil {
		s.fail(w, r, err)
		return
	}

	s.recordAudit(r, wsID, "audit.export", "audit", wsID, fmt.Sprintf("audit-logs-ws-%d.csv", wsID), map[string]any{
		"exportedRows": len(page.Items),
		"totalMatched": page.Total,
		"action":       filter.Action,
		"resourceType": filter.ResourceType,
		"query":        filter.Query,
	})

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="audit-logs-ws-%d.csv"`, wsID))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// getWorkspaceSecurityPolicy handles GET /api/workspaces/{wsId}/security-policy.
func (s *Server) getWorkspaceSecurityPolicy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
	if !ok {
		return
	}
	u, ok := UserFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "login required")
		return
	}
	if !driveExpectedUser(w, r, u.ID) {
		return
	}
	auditStore, ok := s.auditLogStore(w)
	if !ok {
		return
	}
	policy, err := auditStore.GetWorkspaceSecurityPolicy(r.Context(), u.ID, wsID)
	if err != nil {
		s.auditError(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, policy)
}

// putWorkspaceSecurityPolicy handles PUT /api/workspaces/{wsId}/security-policy.
func (s *Server) putWorkspaceSecurityPolicy(w http.ResponseWriter, r *http.Request) {
	wsID, ok := s.parsePositivePathID(w, r, "wsId")
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
	auditStore, ok := s.auditLogStore(w)
	if !ok {
		return
	}
	var patch store.WorkspaceSecurityPolicyPatch
	if !httpx.Decode(w, r, &patch) {
		return
	}
	policy, err := auditStore.UpdateWorkspaceSecurityPolicyGuarded(r.Context(), guard, wsID, patch)
	if err != nil {
		s.auditError(w, r, err)
		return
	}
	s.recordAudit(r, wsID, "org.watermark_update", "workspace", wsID, policy.WatermarkText, map[string]any{
		"watermarkEnabled":   policy.WatermarkEnabled,
		"watermarkText":      policy.WatermarkText,
		"watermarkShowUser":  policy.WatermarkShowUser,
		"watermarkShowEmail": policy.WatermarkShowEmail,
		"watermarkShowDate":  policy.WatermarkShowDate,
		"watermarkOpacity":   policy.WatermarkOpacity,
	})
	httpx.JSON(w, http.StatusOK, policy)
}
