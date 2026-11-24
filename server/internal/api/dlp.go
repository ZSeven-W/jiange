package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"regexp/syntax"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ZSeven-W/jiange/server/internal/httpx"
	"github.com/ZSeven-W/jiange/server/internal/store"
)

const (
	dlpMaxMatches     = 20
	dlpMaxScanBytes   = 2 << 20 // 2 MiB safety cap
	dlpSnippetContext = 24      // runes on each side of a match
	dlpMaxRegexRepeat = 200
	dlpMaxRegexDepth  = 20
)

// DLPMatch represents one sensitive-rule hit found by EvaluateDLP.
type DLPMatch struct {
	Rule    string `json:"rule"`
	Match   string `json:"match"`
	Snippet string `json:"snippet"`
}

type dlpPolicySystemStore interface {
	GetWorkspaceSecurityPolicySystem(ctx context.Context, wsID int64) (store.WorkspaceSecurityPolicy, error)
}

type dlpSheetSystemStore interface {
	GetSheetWorkbookSystem(ctx context.Context, nodeID int64) (store.SheetSnapshot, error)
}

func isDLPRegexRule(rule string) bool {
	return len(rule) >= 2 && strings.HasPrefix(rule, "/") && strings.HasSuffix(rule, "/")
}

func unwrapRegexCapture(re *syntax.Regexp) *syntax.Regexp {
	for re != nil && re.Op == syntax.OpCapture && len(re.Sub) == 1 {
		re = re.Sub[0]
	}
	return re
}

func isUnboundedQuantifier(op syntax.Op, max int) bool {
	return op == syntax.OpPlus || op == syntax.OpStar || (op == syntax.OpRepeat && (max < 0 || max > 1))
}

func hasUnsafeRegexAST(re *syntax.Regexp, depth int) bool {
	if re == nil {
		return false
	}
	if depth > dlpMaxRegexDepth {
		return true
	}
	if re.Op == syntax.OpRepeat && (re.Min > dlpMaxRegexRepeat || re.Max > dlpMaxRegexRepeat) {
		return true
	}
	if isUnboundedQuantifier(re.Op, re.Max) && len(re.Sub) == 1 {
		inner := unwrapRegexCapture(re.Sub[0])
		if inner != nil && isUnboundedQuantifier(inner.Op, inner.Max) {
			return true
		}
	}
	for _, sub := range re.Sub {
		if hasUnsafeRegexAST(sub, depth+1) {
			return true
		}
	}
	return false
}

// validateDLPRegexPattern checks that pattern (the inner body of /pattern/) is
// non-empty, syntactically valid RE2, and free of nested/excessive quantifiers.
func validateDLPRegexPattern(pattern string) (*regexp.Regexp, bool) {
	if pattern == "" || utf8.RuneCountInString(pattern) > store.MaxDLPKeywordRunes {
		return nil, false
	}
	parsed, err := syntax.Parse(pattern, syntax.Perl)
	if err != nil {
		return nil, false
	}
	if hasUnsafeRegexAST(parsed, 0) {
		return nil, false
	}
	compiled, err := regexp.Compile(pattern)
	if err != nil {
		return nil, false
	}
	return compiled, true
}

func compileDLPRule(rule string) (*regexp.Regexp, bool) {
	trimmed := strings.TrimSpace(rule)
	if trimmed == "" || utf8.RuneCountInString(trimmed) > store.MaxDLPKeywordRunes {
		return nil, false
	}
	if isDLPRegexRule(trimmed) {
		return validateDLPRegexPattern(trimmed[1 : len(trimmed)-1])
	}
	compiled, err := regexp.Compile("(?i)" + regexp.QuoteMeta(trimmed))
	if err != nil {
		return nil, false
	}
	return compiled, true
}

func truncateUTF8Bytes(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func buildDLPSnippet(text string, start, end int) string {
	snipStart := start
	for i := 0; i < dlpSnippetContext && snipStart > 0; i++ {
		_, size := utf8.DecodeLastRuneInString(text[:snipStart])
		if size <= 0 {
			break
		}
		snipStart -= size
	}
	snipEnd := end
	for i := 0; i < dlpSnippetContext && snipEnd < len(text); i++ {
		_, size := utf8.DecodeRuneInString(text[snipEnd:])
		if size <= 0 {
			break
		}
		snipEnd += size
	}
	clean := strings.Join(strings.Fields(text[snipStart:snipEnd]), " ")
	if snipStart > 0 {
		clean = "…" + clean
	}
	if snipEnd < len(text) {
		clean = clean + "…"
	}
	return clean
}

// EvaluateDLP scans text against the workspace's DLP rules.
// Literal rules match case-insensitively; rules wrapped in /pattern/ are evaluated
// as RE2 regular expressions. Invalid or unsafe regexes are skipped without panicking.
// Matches are capped at 20.
func EvaluateDLP(policy store.WorkspaceSecurityPolicy, text string) []DLPMatch {
	if !policy.DLPEnabled || len(policy.DLPKeywords) == 0 || text == "" {
		return nil
	}
	scanText := strings.ReplaceAll(text, searchSegmentSep, "\n")
	scanText = truncateUTF8Bytes(scanText, dlpMaxScanBytes)

	var matches []DLPMatch
	for _, rawRule := range policy.DLPKeywords {
		if len(matches) >= dlpMaxMatches {
			break
		}
		rule := strings.TrimSpace(rawRule)
		if rule == "" {
			continue
		}
		re, ok := compileDLPRule(rule)
		if !ok {
			continue
		}
		remaining := dlpMaxMatches - len(matches)
		locs := re.FindAllStringIndex(scanText, remaining+8)
		for _, loc := range locs {
			if len(matches) >= dlpMaxMatches {
				break
			}
			if loc[1] <= loc[0] {
				continue
			}
			matches = append(matches, DLPMatch{
				Rule:    rule,
				Match:   scanText[loc[0]:loc[1]],
				Snippet: buildDLPSnippet(scanText, loc[0], loc[1]),
			})
		}
	}
	if len(matches) == 0 {
		return nil
	}
	return matches
}

func isPublicExternalLinkRole(role string) bool {
	return role == "anon" || role == store.RoleView || role == store.RoleEdit
}

func uniqueMatchedRules(matches []DLPMatch) []string {
	seen := make(map[string]struct{}, len(matches))
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		if _, ok := seen[m.Rule]; ok {
			continue
		}
		seen[m.Rule] = struct{}{}
		out = append(out, m.Rule)
	}
	return out
}

func (s *Server) loadWorkspaceDLPPolicy(ctx context.Context, wsID, actorID int64) (store.WorkspaceSecurityPolicy, bool) {
	if s == nil || s.Store == nil || wsID <= 0 {
		return store.WorkspaceSecurityPolicy{}, false
	}
	if sysStore, ok := s.Store.(dlpPolicySystemStore); ok {
		pol, err := sysStore.GetWorkspaceSecurityPolicySystem(ctx, wsID)
		if err == nil {
			return pol, true
		}
		return store.WorkspaceSecurityPolicy{}, false
	}
	if auditStore, ok := s.Store.(store.AuditLogStore); ok && actorID > 0 {
		pol, err := auditStore.GetWorkspaceSecurityPolicy(ctx, actorID, wsID)
		if err == nil {
			return pol, true
		}
	}
	return store.WorkspaceSecurityPolicy{}, false
}

func (s *Server) extractDocPlainTextForDLP(ctx context.Context, docID int64, actor store.User) string {
	meta, err := s.Store.GetDocSystem(ctx, docID)
	if err != nil {
		if actor.ID <= 0 {
			return ""
		}
		meta, err = s.Store.GetDoc(ctx, actor.ID, docID)
		if err != nil {
			return ""
		}
	}

	var b strings.Builder
	if title := strings.TrimSpace(meta.Title); title != "" {
		b.WriteString(title)
	}

	appendBody := func(body string) {
		if body == "" {
			return
		}
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(body)
	}

	switch meta.Kind {
	case "doc":
		if idxStore, hasIndex := s.Store.(store.SearchIndexStore); hasIndex {
			if epoch, head, err := s.Store.HeadVersion(ctx, docID); err == nil {
				if entry, err := idxStore.GetSearchIndex(ctx, docID); err == nil && entry.SourceEpoch == epoch && entry.SourceSeq == head {
					appendBody(entry.BodyText)
					return b.String()
				}
			}
		}
		if doc, _, err := StateAtHead(ctx, s.Store, docID); err == nil && doc != nil {
			appendBody(extractSearchableDocumentText(doc.View()))
		}
	case "base":
		tables, tErr := s.Store.BaseTables(ctx, docID)
		fields, fErr := s.Store.Fields(ctx, docID)
		records, rErr := s.Store.Records(ctx, docID)
		if tErr == nil && fErr == nil && rErr == nil {
			appendBody(extractSearchableBaseText(tables, fields, records))
		}
	case "slides":
		if actor.ID > 0 {
			if pages, err := s.Store.ListSlidesPages(ctx, actor.ID, docID); err == nil {
				appendBody(extractSearchableSlidesText(pages))
			}
		}
	case "survey":
		if ss, ok := s.Store.(store.SurveyStore); ok {
			if sv, err := ss.GetSurvey(ctx, docID); err == nil {
				appendBody(extractSearchableSurveyText(sv))
			}
		}
	case "sheet":
		if sheetSys, ok := s.Store.(dlpSheetSystemStore); ok {
			if snap, err := sheetSys.GetSheetWorkbookSystem(ctx, docID); err == nil {
				appendBody(extractSearchableSheetText(snap))
			}
		}
	}
	return b.String()
}

func extractSearchableSheetText(snap store.SheetSnapshot) string {
	var b strings.Builder
	writePart := func(raw string) bool {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			return true
		}
		if b.Len() >= dlpMaxScanBytes {
			return false
		}
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		remaining := dlpMaxScanBytes - b.Len()
		if len(trimmed) > remaining {
			b.WriteString(truncateUTF8Bytes(trimmed, remaining))
			return false
		}
		b.WriteString(trimmed)
		return true
	}
	for _, ws := range snap.Sheets {
		if !writePart(ws.Title) {
			break
		}
		for _, cell := range ws.Cells {
			if !writePart(cell.Raw) {
				return b.String()
			}
		}
	}
	return b.String()
}

// checkDocShareDLP evaluates a document's title and plain text against the
// workspace's DLP policy for public external sharing.
// Returns blocked=true only when policy.DLPEnabled && policy.DLPBlockPublicShare
// && policy.DLPAction == "block" and at least one rule matched.
func (s *Server) checkDocShareDLP(ctx context.Context, docID, wsID int64, actor store.User) (blocked bool, matches []DLPMatch) {
	if docID <= 0 || wsID <= 0 {
		return false, nil
	}
	policy, ok := s.loadWorkspaceDLPPolicy(ctx, wsID, actor.ID)
	if !ok || !policy.DLPEnabled || !policy.DLPBlockPublicShare || len(policy.DLPKeywords) == 0 {
		return false, nil
	}
	text := s.extractDocPlainTextForDLP(ctx, docID, actor)
	matches = EvaluateDLP(policy, text)
	if len(matches) == 0 {
		return false, nil
	}
	return policy.DLPAction == store.DLPActionBlock, matches
}

// enforceDocShareDLP runs before enabling a public external link on a document.
// Returns false when the share has been blocked (HTTP 422 response already written).
func (s *Server) enforceDocShareDLP(w http.ResponseWriter, r *http.Request, d store.DocMeta, linkRole string) bool {
	if !isPublicExternalLinkRole(linkRole) {
		return true
	}
	actor, _ := UserFrom(r.Context())
	blocked, matches := s.checkDocShareDLP(r.Context(), d.ID, d.WorkspaceID, actor)
	if len(matches) == 0 {
		return true
	}
	detail := map[string]any{
		"linkRole":     linkRole,
		"matchCount":   len(matches),
		"matchedRules": uniqueMatchedRules(matches),
	}
	if blocked {
		s.recordAudit(r, d.WorkspaceID, "dlp.share_blocked", d.Kind, d.ID, d.Title, detail)
		httpx.JSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":   "dlp_blocked",
			"code":    "dlp_blocked",
			"message": "内容命中企业数据防泄漏（DLP）敏感规则，已拦截对外公开分享",
			"matches": matches,
		})
		return false
	}
	s.recordAudit(r, d.WorkspaceID, "dlp.share_warned", d.Kind, d.ID, d.Title, detail)
	return true
}

// enforceDocExportDLP evaluates a document against workspace DLP rules before
// allowing an export or public file download. Returns false when blocked
// (HTTP 422 JSON response already written).
func (s *Server) enforceDocExportDLP(w http.ResponseWriter, r *http.Request, d store.DocMeta, channel string) bool {
	if d.ID <= 0 || d.WorkspaceID <= 0 {
		return true
	}
	actor, _ := UserFrom(r.Context())
	policy, ok := s.loadWorkspaceDLPPolicy(r.Context(), d.WorkspaceID, actor.ID)
	if !ok || !policy.DLPEnabled || len(policy.DLPKeywords) == 0 {
		return true
	}
	text := s.extractDocPlainTextForDLP(r.Context(), d.ID, actor)
	matches := EvaluateDLP(policy, text)
	if len(matches) == 0 {
		return true
	}
	detail := map[string]any{
		"channel":      channel,
		"matchCount":   len(matches),
		"matchedRules": uniqueMatchedRules(matches),
	}
	if policy.DLPAction == store.DLPActionBlock {
		s.recordAudit(r, d.WorkspaceID, "dlp.export_blocked", d.Kind, d.ID, d.Title, detail)
		httpx.JSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":   "dlp_blocked",
			"code":    "dlp_blocked",
			"message": "内容命中企业数据防泄漏（DLP）敏感规则，已拦截导出/下载",
			"matches": matches,
		})
		return false
	}
	s.recordAudit(r, d.WorkspaceID, "dlp.export_warned", d.Kind, d.ID, d.Title, detail)
	return true
}

// SweepRetentionPolicies runs background data retention cleanup across all
// workspaces with retention_days > 0, purging expired audit logs and soft-deleted
// trash nodes and writing a retention.purged audit entry whenever records were removed.
func SweepRetentionPolicies(ctx context.Context, st store.Store, log *slog.Logger) ([]store.RetentionPurgeStats, error) {
	if st == nil {
		return nil, nil
	}
	auditStore, ok := st.(store.AuditLogStore)
	if !ok {
		return nil, nil
	}
	policies, err := auditStore.ListRetentionPolicies(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	results := make([]store.RetentionPurgeStats, 0, len(policies))
	var firstErr error
	for _, p := range policies {
		if err := ctx.Err(); err != nil {
			return results, err
		}
		if p.WorkspaceID <= 0 || p.RetentionDays <= 0 {
			continue
		}
		cutoff := now.Add(-time.Duration(p.RetentionDays) * 24 * time.Hour)
		purgedLogs, purgedNodes, err := auditStore.PurgeExpiredRetentionData(ctx, p.WorkspaceID, cutoff)
		if err != nil {
			if log != nil {
				log.Warn("retention purge failed", "wsId", p.WorkspaceID, "retentionDays", p.RetentionDays, "err", err)
			}
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		stats := store.RetentionPurgeStats{
			WorkspaceID:      p.WorkspaceID,
			RetentionDays:    p.RetentionDays,
			PurgedAuditLogs:  purgedLogs,
			PurgedTrashNodes: purgedNodes,
			RanAt:            now,
		}
		results = append(results, stats)
		if purgedLogs > 0 || purgedNodes > 0 {
			detail := marshalAuditDetail(map[string]any{
				"trigger":          "scheduled",
				"retentionDays":    p.RetentionDays,
				"cutoff":           cutoff.Format(time.RFC3339),
				"purgedAuditLogs":  purgedLogs,
				"purgedTrashNodes": purgedNodes,
			})
			if err := auditStore.AppendAuditLog(ctx, store.AuditLogEntry{
				WorkspaceID:   p.WorkspaceID,
				ActorID:       0,
				ActorName:     "系统",
				Action:        "retention.purged",
				ResourceType:  "workspace",
				ResourceID:    p.WorkspaceID,
				ResourceTitle: fmt.Sprintf("数据保留自动清理（%d 天）", p.RetentionDays),
				Detail:        detail,
				CreatedAt:     now,
			}); err != nil && log != nil {
				log.Warn("append retention audit log failed", "wsId", p.WorkspaceID, "err", err)
			}
			if log != nil {
				log.Info("retention policy purged expired data",
					"wsId", p.WorkspaceID,
					"retentionDays", p.RetentionDays,
					"purgedAuditLogs", purgedLogs,
					"purgedTrashNodes", purgedNodes,
				)
			}
		}
	}
	return results, firstErr
}

// runWorkspaceRetention handles POST /api/workspaces/{wsId}/retention/run.
// Requires workspace owner or admin. Immediately executes retention cleanup
// using the workspace's configured retention_days policy.
func (s *Server) runWorkspaceRetention(w http.ResponseWriter, r *http.Request) {
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
	orgSnap, err := s.Store.GetWorkspaceOrg(r.Context(), guard, wsID)
	if err != nil {
		s.auditError(w, r, err)
		return
	}
	if orgSnap.CallerRole != store.WorkspaceRoleOwner && orgSnap.CallerRole != store.WorkspaceRoleAdmin {
		httpx.Error(w, http.StatusForbidden, "forbidden", "仅空间所有者或管理员可执行数据保留清理")
		return
	}
	policy, err := auditStore.GetWorkspaceSecurityPolicy(r.Context(), guard.UserID, wsID)
	if err != nil {
		s.auditError(w, r, err)
		return
	}
	if policy.RetentionDays <= 0 {
		httpx.Error(w, http.StatusBadRequest, "retention_disabled", "当前空间未启用数据保留周期，请先设置大于 0 天的保留期限")
		return
	}
	now := s.now().UTC()
	cutoff := now.Add(-time.Duration(policy.RetentionDays) * 24 * time.Hour)
	purgedLogs, purgedNodes, err := auditStore.PurgeExpiredRetentionData(r.Context(), wsID, cutoff)
	if err != nil {
		s.auditError(w, r, err)
		return
	}
	stats := store.RetentionPurgeStats{
		WorkspaceID:      wsID,
		RetentionDays:    policy.RetentionDays,
		PurgedAuditLogs:  purgedLogs,
		PurgedTrashNodes: purgedNodes,
		RanAt:            now,
	}
	s.recordAudit(r, wsID, "retention.purged", "workspace", wsID, fmt.Sprintf("数据保留手动清理（%d 天）", policy.RetentionDays), map[string]any{
		"trigger":          "manual",
		"retentionDays":    policy.RetentionDays,
		"cutoff":           cutoff.Format(time.RFC3339),
		"purgedAuditLogs":  purgedLogs,
		"purgedTrashNodes": purgedNodes,
	})
	httpx.JSON(w, http.StatusOK, stats)
}

// checkWorkspaceDLP handles POST /api/workspaces/{wsId}/dlp/check.
// Requires workspace owner or admin. Evaluates input text against optional draft
// rules (keywords/action) or the workspace's saved DLP policy.
func (s *Server) checkWorkspaceDLP(w http.ResponseWriter, r *http.Request) {
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
	orgSnap, err := s.Store.GetWorkspaceOrg(r.Context(), guard, wsID)
	if err != nil {
		s.auditError(w, r, err)
		return
	}
	if orgSnap.CallerRole != store.WorkspaceRoleOwner && orgSnap.CallerRole != store.WorkspaceRoleAdmin {
		httpx.Error(w, http.StatusForbidden, "forbidden", "仅空间所有者或管理员可执行 DLP 敏感词检测")
		return
	}

	var in struct {
		Text     string    `json:"text"`
		Keywords *[]string `json:"keywords,omitempty"`
		Action   *string   `json:"action,omitempty"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}

	policy, err := auditStore.GetWorkspaceSecurityPolicy(r.Context(), guard.UserID, wsID)
	if err != nil {
		s.auditError(w, r, err)
		return
	}
	if in.Keywords != nil {
		clean, err := store.NormalizeDLPKeywords(*in.Keywords)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_dlp_keywords", "DLP 规则数量不能超过 100 条，单条长度不能超过 120 个字符")
			return
		}
		policy.DLPKeywords = clean
		policy.DLPEnabled = true
	}
	if in.Action != nil {
		act, valid := store.NormalizeDLPAction(*in.Action)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "invalid_dlp_action", "dlpAction must be warn or block")
			return
		}
		policy.DLPAction = act
	}
	if policy.DLPAction == "" {
		policy.DLPAction = store.DLPActionWarn
	}

	matches := EvaluateDLP(policy, in.Text)
	if matches == nil {
		matches = []DLPMatch{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"matched": len(matches) > 0,
		"action":  policy.DLPAction,
		"matches": matches,
	})
}

type policyValidationError struct {
	code    string
	message string
}

func validateSecurityPolicyPatchAPI(patch store.WorkspaceSecurityPolicyPatch) *policyValidationError {
	if patch.DLPAction != nil {
		if _, ok := store.NormalizeDLPAction(*patch.DLPAction); !ok {
			return &policyValidationError{
				code:    "invalid_dlp_action",
				message: "dlpAction must be warn or block",
			}
		}
	}
	if patch.RetentionDays != nil && !store.ValidRetentionDays(*patch.RetentionDays) {
		return &policyValidationError{
			code:    "invalid_retention_days",
			message: "retentionDays must be between 0 and 3650",
		}
	}
	if patch.DLPKeywords != nil {
		clean, err := store.NormalizeDLPKeywords(*patch.DLPKeywords)
		if err != nil {
			return &policyValidationError{
				code:    "invalid_dlp_keywords",
				message: "DLP 规则数量不能超过 100 条，单条长度不能超过 120 个字符",
			}
		}
		for _, rule := range clean {
			if isDLPRegexRule(rule) {
				if _, ok := validateDLPRegexPattern(rule[1 : len(rule)-1]); !ok {
					return &policyValidationError{
						code:    "invalid_dlp_regex",
						message: "DLP 正则规则语法无效或存在性能风险：" + rule,
					}
				}
			}
		}
	}
	return nil
}
