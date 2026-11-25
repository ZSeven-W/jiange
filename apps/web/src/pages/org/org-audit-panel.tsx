import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Database,
  Download,
  FileSearch,
  HardDrive,
  Plus,
  RefreshCw,
  Save,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Stamp,
  Trash2,
  X,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  enterpriseApi,
  type AttachmentReindexStats,
  type AuditLogEntry,
  type AuditLogPage,
  type DlpAction,
  type DlpCheckResult,
  type RetentionPurgeStats,
  type WorkspaceSecurityPolicy,
  type WorkspaceStorageUsage,
} from "@/lib/enterprise-api";
import {
  DEFAULT_WATERMARK_OPACITY,
  DocumentWatermark,
  MAX_WATERMARK_OPACITY,
  MIN_WATERMARK_OPACITY,
  formatWatermarkLabel,
  workspaceSecurityPolicyQueryKey,
} from "@/components/document-watermark";
import { FeishuSelect, type FeishuSelectOption } from "@/components/feishu-select";
import { t, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const AUDIT_PAGE_SIZE = 20;
export const MAX_DLP_KEYWORDS = 100;
export const MAX_DLP_KEYWORD_RUNES = 120;
export const DLP_ID_REGEX = "/\\b\\d{17}[\\dXx]\\b/";
export const DLP_PHONE_REGEX = "/\\b1[3-9]\\d{9}\\b/";
export const RETENTION_PRESET_DAYS = [0, 30, 90, 180, 365] as const;

export const workspaceStorageQueryKey = (workspaceId: number, userId: number) =>
  ["workspace-storage-usage", workspaceId, userId] as const;

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  if (idx === 0) return `${Math.round(value)} B`;
  const formatted = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formatted.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")} ${units[idx]}`;
}

type StorageQuotaUnit = "unlimited" | "MB" | "GB";

const STORAGE_MIB = 1024 * 1024;
const STORAGE_GIB = 1024 * 1024 * 1024;

function deriveQuotaForm(quotaBytes: number): { unit: StorageQuotaUnit; amount: string } {
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
    return { unit: "unlimited", amount: "10" };
  }
  if (quotaBytes >= STORAGE_GIB) {
    const gb = quotaBytes / STORAGE_GIB;
    const rounded = Number.isInteger(gb) ? String(gb) : String(Number(gb.toFixed(2)));
    return { unit: "GB", amount: rounded };
  }
  const mb = Math.max(1, Math.round(quotaBytes / STORAGE_MIB));
  return { unit: "MB", amount: String(mb) };
}

export const auditLogsQueryKey = (
  workspaceId: number,
  userId: number,
  filters: { action: string; resourceType: string; q: string; offset: number },
) =>
  [
    "workspace-audit-logs",
    workspaceId,
    userId,
    filters.action,
    filters.resourceType,
    filters.q,
    filters.offset,
  ] as const;

export const KNOWN_AUDIT_ACTIONS = [
  "auth.login",
  "auth.sso_login",
  "auth.mfa_login",
  "auth.mfa_enable",
  "auth.mfa_disable",
  "auth.passkey_registered",
  "auth.passkey_deleted",
  "auth.passkey_login",
  "auth.logout",
  "doc.create",
  "doc.update",
  "doc.delete",
  "doc.restore",
  "share.update",
  "share.link_update",
  "dlp.share_blocked",
  "dlp.share_warned",
  "dlp.export_blocked",
  "dlp.export_warned",
  "retention.purged",
  "org.member_update",
  "org.member_invite",
  "org.member_remove",
  "org.department_update",
  "org.group_update",
  "org.watermark_update",
  "org.sso_update",
  "org.sync_run",
  "base.permissions_update",
  "workspace.storage_quota_updated",
  "workspace.attachments_reindexed",
  "audit.export",
] as const;

export const AUDIT_RESOURCE_TYPES = [
  "doc",
  "sheet",
  "base",
  "slides",
  "wiki",
  "workspace",
  "org",
  "auth",
  "audit",
] as const;

/** Maps backend audit action identifiers to localized UI labels. */
export function formatAuditActionLabel(action: string): string {
  switch (action) {
    case "auth.login":
      return t("账号登录");
    case "auth.sso_login":
      return t("SSO 单点登录");
    case "auth.mfa_login":
      return t("二步验证登录");
    case "auth.mfa_enable":
      return t("开启二步验证");
    case "auth.mfa_disable":
      return t("关闭二步验证");
    case "auth.passkey_registered":
      return t("绑定通行密钥");
    case "auth.passkey_deleted":
      return t("移除通行密钥");
    case "auth.passkey_login":
      return t("通行密钥登录");
    case "auth.logout":
      return t("退出登录");
    case "doc.create":
      return t("创建文档");
    case "doc.update":
      return t("更新文档");
    case "doc.delete":
      return t("删除文档");
    case "doc.restore":
      return t("恢复文档");
    case "share.update":
      return t("变更共享权限");
    case "share.link_update":
      return t("变更链接共享");
    case "dlp.share_blocked":
      return t("DLP 拦截公开分享");
    case "dlp.share_warned":
      return t("DLP 敏感词告警");
    case "dlp.export_blocked":
      return t("DLP 拦截导出/下载");
    case "dlp.export_warned":
      return t("DLP 导出敏感告警");
    case "retention.purged":
      return t("执行数据保留清理");
    case "org.member_update":
      return t("变更成员角色");
    case "org.member_invite":
      return t("邀请成员");
    case "org.member_remove":
      return t("移除成员");
    case "org.department_update":
      return t("变更部门架构");
    case "org.group_update":
      return t("变更用户组");
    case "org.watermark_update":
      return t("变更水印策略");
    case "org.sso_update":
      return t("变更 SSO 配置");
    case "org.sync_run":
      return t("执行目录同步");
    case "base.permissions_update":
      return t("变更表格权限");
    case "workspace.storage_quota_updated":
      return t("调整存储配额");
    case "workspace.attachments_reindexed":
      return t("重建附件索引");
    case "audit.export":
      return t("导出审计日志");
    default:
      return action;
  }
}

export function formatAuditResourceTypeLabel(resourceType: string): string {
  switch (resourceType) {
    case "doc":
      return t("云文档");
    case "sheet":
      return t("电子表格");
    case "base":
      return t("多维表格");
    case "slides":
      return t("演示文稿");
    case "file":
      return t("云盘文件");
    case "wiki":
      return t("知识库");
    case "workspace":
      return t("工作空间");
    case "org":
      return t("组织架构");
    case "auth":
      return t("身份认证");
    case "audit":
      return t("审计日志");
    default:
      return resourceType || "-";
  }
}

function actionBadgeTone(action: string): string {
  if (action.startsWith("auth.")) {
    return "bg-[#e1eaff] text-[#1456f0] dark:bg-[#1d3461] dark:text-[#6698ff]";
  }
  if (
    action.endsWith(".delete") ||
    action.endsWith(".remove") ||
    action === "dlp.share_blocked" ||
    action === "dlp.export_blocked"
  ) {
    return "bg-[#fde2e2] text-[#d83931] dark:bg-[#4c1d1d] dark:text-[#ff7875]";
  }
  if (action.startsWith("audit.") || action.startsWith("retention.")) {
    return "bg-[#f0e6ff] text-[#6425d0] dark:bg-[#2d1e4f] dark:text-[#b388ff]";
  }
  if (
    action.startsWith("org.") ||
    action.startsWith("share.") ||
    action.startsWith("dlp.") ||
    action.includes("permissions")
  ) {
    return "bg-[#fff3e0] text-[#c26a00] dark:bg-[#4a2f0b] dark:text-[#ffb74d]";
  }
  return "bg-[#e3f9e5] text-[#008026] dark:bg-[#143d1f] dark:text-[#52c41a]";
}

function formatAuditTime(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface OrgAuditPanelProps {
  workspaceId: number;
  userId: number;
  userName: string;
  userEmail: string;
  canAdmin: boolean;
}

export function OrgAuditPanel({
  workspaceId,
  userId,
  userName,
  userEmail,
  canAdmin,
}: OrgAuditPanelProps) {
  const { t } = useI18n();
  const qc = useQueryClient();

  const [draftOverride, setDraftOverride] = useState<Partial<WorkspaceSecurityPolicy> | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // DLP rule editor & live check sandbox state
  const [dlpRuleInput, setDlpRuleInput] = useState("");
  const [dlpTestInput, setDlpTestInput] = useState("");
  const [testingDlp, setTestingDlp] = useState(false);
  const [dlpTestResult, setDlpTestResult] = useState<DlpCheckResult | null>(null);
  const [dlpTestError, setDlpTestError] = useState("");
  const [runningRetention, setRunningRetention] = useState(false);
  const [retentionResult, setRetentionResult] = useState<RetentionPurgeStats | null>(null);
  const [retentionError, setRetentionError] = useState("");

  // Storage usage, quota & attachment reindex state
  const [quotaUnitOverride, setQuotaUnitOverride] = useState<StorageQuotaUnit | null>(null);
  const [quotaAmountOverride, setQuotaAmountOverride] = useState<string | null>(null);
  const [savingQuota, setSavingQuota] = useState(false);
  const [quotaError, setQuotaError] = useState("");
  const [quotaNotice, setQuotaNotice] = useState("");
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState<AttachmentReindexStats | null>(null);
  const [reindexError, setReindexError] = useState("");

  // Audit filter & pagination state
  const [searchInput, setSearchInput] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [resourceFilter, setResourceFilter] = useState("");
  const [page, setPage] = useState(0);

  // Reset local draft and filters when switching workspace
  useEffect(() => {
    setDraftOverride(null);
    setDlpRuleInput("");
    setDlpTestInput("");
    setDlpTestResult(null);
    setDlpTestError("");
    setRetentionResult(null);
    setRetentionError("");
    setQuotaUnitOverride(null);
    setQuotaAmountOverride(null);
    setQuotaError("");
    setQuotaNotice("");
    setReindexResult(null);
    setReindexError("");
    setSearchInput("");
    setActionFilter("");
    setResourceFilter("");
    setPage(0);
    setError("");
    setNotice("");
  }, [workspaceId]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const policyKey = workspaceSecurityPolicyQueryKey(workspaceId);
  const policyQuery = useQuery<WorkspaceSecurityPolicy>({
    queryKey: policyKey,
    queryFn: ({ signal }) => enterpriseApi.getSecurityPolicy(workspaceId, userId, signal),
    enabled: workspaceId > 0,
  });

  const serverPolicy: WorkspaceSecurityPolicy = {
    workspaceId,
    watermarkEnabled: false,
    watermarkText: "",
    watermarkShowUser: true,
    watermarkShowEmail: true,
    watermarkShowDate: true,
    watermarkOpacity: DEFAULT_WATERMARK_OPACITY,
    dlpEnabled: false,
    dlpKeywords: [],
    dlpAction: "warn",
    dlpBlockPublicShare: true,
    retentionDays: 0,
    requireMfa: false,
    updatedBy: 0,
    updatedAt: "",
    ...(policyQuery.data ?? {}),
  };

  const draft: WorkspaceSecurityPolicy = draftOverride
    ? { ...serverPolicy, ...draftOverride }
    : serverPolicy;

  const dlpEnabled = Boolean(draft.dlpEnabled);
  const dlpKeywords = draft.dlpKeywords ?? [];
  const dlpAction: DlpAction = draft.dlpAction === "block" ? "block" : "warn";
  const dlpBlockPublicShare = draft.dlpBlockPublicShare ?? true;
  const retentionDays =
    typeof draft.retentionDays === "number" && Number.isFinite(draft.retentionDays)
      ? Math.max(0, Math.min(3650, Math.trunc(draft.retentionDays)))
      : 0;
  const requireMfa = Boolean(draft.requireMfa);

  const updateDraft = (patch: Partial<WorkspaceSecurityPolicy>) => {
    setDraftOverride((prev) => ({ ...(prev ?? {}), ...patch }));
  };

  const offset = page * AUDIT_PAGE_SIZE;
  const trimmedQuery = searchInput.trim();
  const auditKey = auditLogsQueryKey(workspaceId, userId, {
    action: actionFilter,
    resourceType: resourceFilter,
    q: trimmedQuery,
    offset,
  });

  const storageKey = workspaceStorageQueryKey(workspaceId, userId);
  const storageQuery = useQuery<WorkspaceStorageUsage>({
    queryKey: storageKey,
    queryFn: ({ signal }) => enterpriseApi.getWorkspaceStorage(workspaceId, userId, signal),
    enabled: workspaceId > 0 && canAdmin,
  });

  const storageUsage = storageQuery.data;
  const derivedQuota = useMemo(
    () => deriveQuotaForm(storageUsage?.quotaBytes ?? 0),
    [storageUsage?.quotaBytes],
  );
  const quotaUnit: StorageQuotaUnit = quotaUnitOverride ?? derivedQuota.unit;
  const quotaAmount = quotaAmountOverride ?? derivedQuota.amount;

  const quotaUnitOptions = useMemo<FeishuSelectOption[]>(
    () => [
      { value: "unlimited", label: t("不限制") },
      { value: "MB", label: "MB" },
      { value: "GB", label: "GB" },
    ],
    [t],
  );

  const storageUsedBytes = storageUsage?.usedBytes ?? 0;
  const storageQuotaBytes = storageUsage?.quotaBytes ?? 0;
  const storageRatio =
    storageQuotaBytes > 0 ? Math.min(1, Math.max(0, storageUsedBytes / storageQuotaBytes)) : 0;
  const storagePercent = storageQuotaBytes > 0 ? Math.round((storageUsedBytes / storageQuotaBytes) * 100) : 0;
  const storageBarPercent = storageQuotaBytes > 0 ? Math.min(100, Math.round(storageRatio * 100)) : 0;

  const auditQuery = useQuery<AuditLogPage>({
    queryKey: auditKey,
    queryFn: ({ signal }) =>
      enterpriseApi.listAuditLogs(
        workspaceId,
        {
          action: actionFilter || undefined,
          resourceType: resourceFilter || undefined,
          q: trimmedQuery || undefined,
          limit: AUDIT_PAGE_SIZE,
          offset,
        },
        userId,
        signal,
      ),
    enabled: workspaceId > 0 && canAdmin,
  });

  const actionOptions = useMemo<FeishuSelectOption[]>(() => {
    const merged = new Set<string>(KNOWN_AUDIT_ACTIONS);
    for (const act of auditQuery.data?.actions ?? []) {
      if (act) merged.add(act);
    }
    return [
      { value: "", label: t("全部操作类型") },
      ...Array.from(merged).map((act) => ({
        value: act,
        label: formatAuditActionLabel(act),
      })),
    ];
  }, [auditQuery.data?.actions, t]);

  const resourceOptions = useMemo<FeishuSelectOption[]>(
    () => [
      { value: "", label: t("全部资源类型") },
      ...AUDIT_RESOURCE_TYPES.map((rt) => ({
        value: rt,
        label: formatAuditResourceTypeLabel(rt),
      })),
    ],
    [t],
  );

  const dlpActionOptions = useMemo<FeishuSelectOption[]>(
    () => [
      { value: "warn", label: t("仅警告并记录审计") },
      { value: "block", label: t("拦截对外公开分享") },
    ],
    [t],
  );

  const retentionOptions = useMemo<FeishuSelectOption[]>(() => {
    const base: FeishuSelectOption[] = [
      { value: "0", label: t("永久保留") },
      { value: "30", label: t("30 天") },
      { value: "90", label: t("90 天") },
      { value: "180", label: t("180 天") },
      { value: "365", label: t("365 天") },
    ];
    if (!RETENTION_PRESET_DAYS.includes(retentionDays as (typeof RETENTION_PRESET_DAYS)[number])) {
      base.push({ value: String(retentionDays), label: t("{days} 天", { days: retentionDays }) });
    }
    return base;
  }, [retentionDays, t]);

  const opacityPercent = Math.round(
    Math.min(MAX_WATERMARK_OPACITY, Math.max(MIN_WATERMARK_OPACITY, draft.watermarkOpacity)) * 100,
  );
  const textRuneCount = Array.from(draft.watermarkText).length;
  const previewLabel = formatWatermarkLabel({
    policy: { ...draft, watermarkEnabled: true },
    userName,
    userEmail,
  });

  const handleSavePolicy = async () => {
    if (!canAdmin || savingPolicy || !workspaceId) return;
    setSavingPolicy(true);
    setError("");
    setNotice("");
    try {
      const saved = await enterpriseApi.updateSecurityPolicy(
        workspaceId,
        {
          watermarkEnabled: draft.watermarkEnabled,
          watermarkText: draft.watermarkText,
          watermarkShowUser: draft.watermarkShowUser,
          watermarkShowEmail: draft.watermarkShowEmail,
          watermarkShowDate: draft.watermarkShowDate,
          watermarkOpacity: draft.watermarkOpacity,
          dlpEnabled,
          dlpKeywords,
          dlpAction,
          dlpBlockPublicShare,
          retentionDays,
          requireMfa,
        },
        userId,
      );
      qc.setQueryData(policyKey, saved);
      setDraftOverride(null);
      await qc.invalidateQueries({ queryKey: ["workspace-audit-logs", workspaceId] });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("jiange:mfa-updated"));
      }
      setNotice(t("安全策略已保存并同步至全套件"));
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else if (e instanceof Error) setError(e.message);
      else setError(t("保存失败"));
    } finally {
      setSavingPolicy(false);
    }
  };

  const addDlpRules = (candidates: readonly string[]) => {
    if (!canAdmin || savingPolicy) return;
    const next = [...dlpKeywords];
    const seen = new Set(next);
    let added = false;
    for (const raw of candidates) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (Array.from(trimmed).length > MAX_DLP_KEYWORD_RUNES) {
        setError(t("单条敏感词规则不能超过 120 个字符"));
        return;
      }
      if (seen.has(trimmed)) continue;
      if (next.length >= MAX_DLP_KEYWORDS) {
        setError(t("敏感词规则最多支持 100 条"));
        return;
      }
      seen.add(trimmed);
      next.push(trimmed);
      added = true;
    }
    if (added) {
      setError("");
      updateDraft({ dlpKeywords: next });
      setDlpTestResult(null);
    }
  };

  const handleAddRuleInput = () => {
    const trimmed = dlpRuleInput.trim();
    if (!trimmed) return;
    addDlpRules([trimmed]);
    setDlpRuleInput("");
  };

  const handleRemoveDlpRule = (rule: string) => {
    if (!canAdmin || savingPolicy) return;
    updateDraft({ dlpKeywords: dlpKeywords.filter((item) => item !== rule) });
    setDlpTestResult(null);
  };

  const handleTestDlp = async () => {
    if (!canAdmin || testingDlp || !workspaceId) return;
    const text = dlpTestInput.trim();
    if (!text) {
      setDlpTestError(t("请输入待检测的测试文本"));
      setDlpTestResult(null);
      return;
    }
    setTestingDlp(true);
    setDlpTestError("");
    try {
      const res = await enterpriseApi.checkDlp(
        workspaceId,
        {
          text,
          keywords: dlpKeywords,
          action: dlpAction,
        },
        userId,
      );
      setDlpTestResult(res);
    } catch (e) {
      setDlpTestResult(null);
      if (e instanceof ApiError) setDlpTestError(e.message);
      else if (e instanceof Error) setDlpTestError(e.message);
      else setDlpTestError(t("敏感词检测失败"));
    } finally {
      setTestingDlp(false);
    }
  };

  const handleRunRetentionPurge = async () => {
    if (!canAdmin || savingPolicy || runningRetention || !workspaceId || retentionDays <= 0) return;
    setRunningRetention(true);
    setRetentionError("");
    setRetentionResult(null);
    setError("");
    setNotice("");
    try {
      const stats = await enterpriseApi.runRetentionPurge(workspaceId, userId);
      setRetentionResult(stats);
      await qc.invalidateQueries({ queryKey: ["workspace-audit-logs", workspaceId] });
      setNotice(
        t("数据保留清理完成：已清理 {logs} 条审计日志、{nodes} 个过期回收站节点", {
          logs: stats.purgedAuditLogs,
          nodes: stats.purgedTrashNodes,
        }),
      );
    } catch (e) {
      if (e instanceof ApiError) setRetentionError(e.message);
      else if (e instanceof Error) setRetentionError(e.message);
      else setRetentionError(t("执行数据保留清理失败"));
    } finally {
      setRunningRetention(false);
    }
  };

  const handleSaveQuota = async () => {
    if (!canAdmin || savingQuota || !workspaceId) return;
    setQuotaError("");
    setQuotaNotice("");
    setError("");

    let nextQuotaBytes = 0;
    if (quotaUnit !== "unlimited") {
      const parsed = Number(quotaAmount.trim());
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setQuotaError(t("请输入大于 0 的有效配额数值"));
        return;
      }
      nextQuotaBytes = Math.round(parsed * (quotaUnit === "GB" ? STORAGE_GIB : STORAGE_MIB));
      if (!Number.isSafeInteger(nextQuotaBytes) || nextQuotaBytes <= 0) {
        setQuotaError(t("请输入大于 0 的有效配额数值"));
        return;
      }
    }

    setSavingQuota(true);
    try {
      const updated = await enterpriseApi.updateWorkspaceStorageQuota(
        workspaceId,
        nextQuotaBytes,
        userId,
      );
      qc.setQueryData(storageKey, updated);
      setQuotaUnitOverride(null);
      setQuotaAmountOverride(null);
      await qc.invalidateQueries({ queryKey: ["workspace-audit-logs", workspaceId] });
      setQuotaNotice(t("存储配额已更新"));
      setNotice(t("存储配额已更新"));
    } catch (e) {
      if (e instanceof ApiError) setQuotaError(e.message);
      else if (e instanceof Error) setQuotaError(e.message);
      else setQuotaError(t("保存存储配额失败"));
    } finally {
      setSavingQuota(false);
    }
  };

  const handleReindexAttachments = async () => {
    if (!canAdmin || reindexing || !workspaceId) return;
    setReindexing(true);
    setReindexError("");
    setReindexResult(null);
    setError("");
    try {
      const stats = await enterpriseApi.reindexWorkspaceAttachments(workspaceId, userId);
      setReindexResult(stats);
      await Promise.all([
        qc.invalidateQueries({ queryKey: storageKey }),
        qc.invalidateQueries({ queryKey: ["workspace-audit-logs", workspaceId] }),
      ]);
      setNotice(
        t("附件索引重建完成：扫描 {scanned} 个、成功索引 {indexed} 个、跳过 {skipped} 个、失败 {failed} 个", {
          scanned: stats.scanned,
          indexed: stats.indexed,
          skipped: stats.skipped,
          failed: stats.failed,
        }),
      );
    } catch (e) {
      if (e instanceof ApiError) setReindexError(e.message);
      else if (e instanceof Error) setReindexError(e.message);
      else setReindexError(t("重建附件全文索引失败"));
    } finally {
      setReindexing(false);
    }
  };

  const handleExportCsv = async () => {
    if (!canAdmin || exportingCsv || !workspaceId) return;
    setExportingCsv(true);
    setError("");
    try {
      const { blob, filename } = await enterpriseApi.exportAuditLogsCsv(
        workspaceId,
        {
          action: actionFilter || undefined,
          resourceType: resourceFilter || undefined,
          q: trimmedQuery || undefined,
        },
        userId,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      await qc.invalidateQueries({ queryKey: ["workspace-audit-logs", workspaceId] });
      setNotice(t("审计日志 CSV 导出成功"));
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else if (e instanceof Error) setError(e.message);
      else setError(t("导出审计日志失败"));
    } finally {
      setExportingCsv(false);
    }
  };

  const items: AuditLogEntry[] = auditQuery.data?.items ?? [];
  const total = auditQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const hasPrev = page > 0;
  const hasNext = offset + AUDIT_PAGE_SIZE < total;

  return (
    <div className="space-y-4" data-org-audit-panel="">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-[13px] text-primary"
        >
          {notice}
        </p>
      )}

      {/* Section 1: Unified Suite Watermark Policy */}
      <section className="rounded-lg border bg-surface p-4" data-watermark-policy-section="">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">
              <Stamp size={16} className="text-primary" aria-hidden />
              {t("全套件安全水印策略")}
            </h2>
            <p className="mt-0.5 text-[12px] text-subtle">
              {t("统一为空间内的云文档、电子表格、多维表格与演示文稿启用防泄密倾斜平铺水印。")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleSavePolicy()}
            disabled={!canAdmin || savingPolicy}
            data-watermark-save=""
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save size={14} aria-hidden />
            {savingPolicy ? t("保存中…") : t("保存水印策略")}
          </button>
        </div>

        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            {/* Toggle switch */}
            <div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3.5 py-2.5">
              <div>
                <p className="text-[13px] font-medium">{t("开启全局文档水印")}</p>
                <p className="text-[12px] text-subtle">
                  {t("开启后，所有成员访问空间文档时都会自动叠加密文身份水印")}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={draft.watermarkEnabled}
                aria-label={t("开启全局文档水印")}
                disabled={!canAdmin || savingPolicy}
                data-watermark-toggle=""
                onClick={() => updateDraft({ watermarkEnabled: !draft.watermarkEnabled })}
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  draft.watermarkEnabled ? "bg-primary" : "bg-[#c9cdd4] dark:bg-[#4e5259]",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                    draft.watermarkEnabled ? "translate-x-6" : "translate-x-1",
                  )}
                />
              </button>
            </div>

            {/* Custom prefix text */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[12px]">
                <label htmlFor="org-watermark-prefix" className="font-medium text-foreground">
                  {t("自定义水印前缀")}
                </label>
                <span className="text-subtle">{textRuneCount}/80</span>
              </div>
              <input
                id="org-watermark-prefix"
                type="text"
                maxLength={80}
                value={draft.watermarkText}
                disabled={!canAdmin || savingPolicy}
                onChange={(e) => updateDraft({ watermarkText: e.target.value })}
                placeholder={t("例如：内部机密 · 禁止外传")}
                data-watermark-prefix-input=""
                className="h-9 w-full rounded-md border bg-surface px-3 text-[13px] placeholder:text-subtle disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>

            {/* Metadata checkboxes */}
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-foreground">{t("水印显示要素")}</p>
              <div className="flex flex-wrap items-center gap-4 pt-0.5 text-[13px]">
                <label className="inline-flex cursor-pointer items-center gap-2 select-none">
                  <input
                    type="checkbox"
                    checked={draft.watermarkShowUser}
                    disabled={!canAdmin || savingPolicy}
                    onChange={(e) => updateDraft({ watermarkShowUser: e.target.checked })}
                    data-watermark-show-user=""
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  <span>{t("显示姓名")}</span>
                </label>
                <label className="inline-flex cursor-pointer items-center gap-2 select-none">
                  <input
                    type="checkbox"
                    checked={draft.watermarkShowEmail}
                    disabled={!canAdmin || savingPolicy}
                    onChange={(e) => updateDraft({ watermarkShowEmail: e.target.checked })}
                    data-watermark-show-email=""
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  <span>{t("显示邮箱")}</span>
                </label>
                <label className="inline-flex cursor-pointer items-center gap-2 select-none">
                  <input
                    type="checkbox"
                    checked={draft.watermarkShowDate}
                    disabled={!canAdmin || savingPolicy}
                    onChange={(e) => updateDraft({ watermarkShowDate: e.target.checked })}
                    data-watermark-show-date=""
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  <span>{t("显示日期")}</span>
                </label>
              </div>
            </div>

            {/* Opacity slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[12px]">
                <label htmlFor="org-watermark-opacity" className="font-medium text-foreground">
                  {t("水印透明度")}
                </label>
                <span className="font-mono text-subtle" data-watermark-opacity-value="">
                  {opacityPercent}%
                </span>
              </div>
              <input
                id="org-watermark-opacity"
                type="range"
                min={2}
                max={25}
                step={1}
                value={opacityPercent}
                disabled={!canAdmin || savingPolicy}
                onChange={(e) => updateDraft({ watermarkOpacity: Number(e.target.value) / 100 })}
                data-watermark-opacity-slider=""
                className="w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
              />
              <div className="flex justify-between text-[11px] text-subtle">
                <span>2%</span>
                <span>25%</span>
              </div>
            </div>

            {!canAdmin && (
              <p className="text-[12px] text-subtle">
                {t("仅空间所有者或管理员可修改安全水印策略。")}
              </p>
            )}
          </div>

          {/* Live mini preview box */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12px]">
              <span className="font-medium text-foreground">{t("水印实时预览")}</span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium",
                  draft.watermarkEnabled
                    ? "bg-[#e3f9e5] text-[#008026] dark:bg-[#143d1f] dark:text-[#52c41a]"
                    : "bg-muted text-subtle",
                )}
              >
                {draft.watermarkEnabled ? t("已开启") : t("未开启")}
              </span>
            </div>
            <div
              data-watermark-preview=""
              className="relative flex-1 min-h-[164px] overflow-hidden rounded-lg border bg-background p-4"
            >
              {/* Mock document lines */}
              <div className="space-y-2.5 opacity-70" aria-hidden="true">
                <div className="h-3.5 w-2/5 rounded bg-muted-foreground/20" />
                <div className="h-2.5 w-full rounded bg-muted-foreground/10" />
                <div className="h-2.5 w-5/6 rounded bg-muted-foreground/10" />
                <div className="h-2.5 w-4/5 rounded bg-muted-foreground/10" />
                <div className="pt-2 grid grid-cols-3 gap-2">
                  <div className="h-8 rounded border bg-surface/80" />
                  <div className="h-8 rounded border bg-surface/80" />
                  <div className="h-8 rounded border bg-surface/80" />
                </div>
              </div>
              {draft.watermarkEnabled && (
                <DocumentWatermark
                  policy={draft}
                  userName={userName}
                  userEmail={userEmail}
                  contained
                />
              )}
            </div>
            <p className="truncate text-[11px] text-subtle" title={previewLabel ?? ""}>
              {draft.watermarkEnabled && previewLabel
                ? t("当前水印内容：{label}", { label: previewLabel })
                : t("开启后将覆盖云文档、电子表格、多维表格与演示文稿")}
            </p>
          </div>
        </div>
      </section>

      {/* Section 2: Enterprise DLP Sensitive-Word Guard & Data Retention Policy */}
      <section className="rounded-lg border bg-surface p-4" data-dlp-policy-card="">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">
              <ShieldCheck size={16} className="text-primary" aria-hidden />
              {t("数据防泄漏（DLP）与保留策略")}
            </h2>
            <p className="mt-0.5 text-[12px] text-subtle">
              {t("通过关键词与正则表达式自动识别文档敏感信息，拦截高风险公开外发，并统一配置回收站与审计数据保留周期。")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleSavePolicy()}
            disabled={!canAdmin || savingPolicy}
            data-dlp-save=""
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save size={14} aria-hidden />
            {savingPolicy ? t("保存中…") : t("保存安全策略")}
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {/* Workspace-Enforced MFA Policy Toggle */}
          <div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3.5 py-2.5">
            <div>
              <p className="text-[13px] font-medium">
                {t("强制工作空间全员开启二步验证（MFA / Passkey）")}
              </p>
              <p className="text-[12px] text-subtle">
                {t("开启后，工作空间成员必须配置 TOTP 二步验证或绑定通行密钥（Passkey），且不可移除最后一项验证方式")}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={requireMfa}
              aria-label={t("强制工作空间全员开启二步验证（MFA / Passkey）")}
              disabled={!canAdmin || savingPolicy}
              data-require-mfa-toggle=""
              onClick={() => updateDraft({ requireMfa: !requireMfa })}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                requireMfa ? "bg-primary" : "bg-[#c9cdd4] dark:bg-[#4e5259]",
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                  requireMfa ? "translate-x-6" : "translate-x-1",
                )}
              />
            </button>
          </div>

          {/* DLP Enable Toggle */}
          <div className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3.5 py-2.5">
            <div>
              <p className="text-[13px] font-medium">{t("启用企业 DLP 敏感词策略")}</p>
              <p className="text-[12px] text-subtle">
                {t("开启后，对外公开分享文档时将自动扫描标题与正文内容，按处置动作记录告警或拦截外发")}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={dlpEnabled}
              aria-label={t("启用企业 DLP 敏感词策略")}
              disabled={!canAdmin || savingPolicy}
              data-dlp-enabled-toggle=""
              onClick={() => updateDraft({ dlpEnabled: !dlpEnabled })}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                dlpEnabled ? "bg-primary" : "bg-[#c9cdd4] dark:bg-[#4e5259]",
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                  dlpEnabled ? "translate-x-6" : "translate-x-1",
                )}
              />
            </button>
          </div>

          {/* Keywords & Regex Rules Editor */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
              <label htmlFor="org-dlp-rule-input" className="font-medium text-foreground">
                {t("敏感词与正则规则")}
              </label>
              <span className="font-mono text-subtle">
                {dlpKeywords.length}/{MAX_DLP_KEYWORDS}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                id="org-dlp-rule-input"
                type="text"
                maxLength={MAX_DLP_KEYWORD_RUNES}
                value={dlpRuleInput}
                disabled={!canAdmin || savingPolicy}
                onChange={(e) => setDlpRuleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddRuleInput();
                  }
                }}
                placeholder={t("输入关键词或 /正则表达式/，例如：绝密 或 /1[3-9][0-9]{9}/")}
                data-dlp-rule-input=""
                className="h-9 min-w-[240px] flex-1 rounded-md border bg-surface px-3 text-[13px] placeholder:text-subtle disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="button"
                disabled={!canAdmin || savingPolicy || !dlpRuleInput.trim()}
                onClick={handleAddRuleInput}
                data-dlp-add-rule-btn=""
                className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1 rounded-md border bg-surface px-3 text-[13px] font-medium transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus size={14} aria-hidden />
                {t("添加规则")}
              </button>
            </div>

            {/* Quick Presets */}
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="text-subtle">{t("快捷预设：")}</span>
              <button
                type="button"
                disabled={!canAdmin || savingPolicy}
                onClick={() => addDlpRules(["绝密"])}
                data-dlp-preset="top-secret"
                className="inline-flex h-6 cursor-pointer items-center rounded-full border bg-background px-2.5 text-[12px] text-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                + {t("绝密")}
              </button>
              <button
                type="button"
                disabled={!canAdmin || savingPolicy}
                onClick={() => addDlpRules(["内部机密"])}
                data-dlp-preset="confidential"
                className="inline-flex h-6 cursor-pointer items-center rounded-full border bg-background px-2.5 text-[12px] text-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                + {t("内部机密")}
              </button>
              <button
                type="button"
                disabled={!canAdmin || savingPolicy}
                onClick={() => addDlpRules([DLP_ID_REGEX, DLP_PHONE_REGEX])}
                data-dlp-preset="pii-regex"
                className="inline-flex h-6 cursor-pointer items-center rounded-full border bg-background px-2.5 text-[12px] text-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                + {t("身份证/手机号正则")}
              </button>
            </div>

            {/* Removable Rule Chips */}
            <div className="flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-md border bg-background/50 p-2">
              {dlpKeywords.length === 0 ? (
                <span className="px-1 text-[12px] text-subtle">
                  {t("暂未配置敏感词规则，可手动添加关键词、/正则表达式/ 或点击上方快捷预设。")}
                </span>
              ) : (
                dlpKeywords.map((rule) => {
                  const isRegex = rule.length >= 2 && rule.startsWith("/") && rule.endsWith("/");
                  return (
                    <span
                      key={rule}
                      data-dlp-rule-chip={rule}
                      className={cn(
                        "inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12px]",
                        isRegex
                          ? "border-[#c4b5fd] bg-[#f5f3ff] font-mono text-[#5b21b6] dark:border-[#4c1d95] dark:bg-[#2e1065]/60 dark:text-[#c4b5fd]"
                          : "border-primary/25 bg-primary/8 text-primary",
                      )}
                    >
                      <span className="truncate" title={rule}>
                        {rule}
                      </span>
                      {canAdmin && (
                        <button
                          type="button"
                          disabled={savingPolicy}
                          onClick={() => handleRemoveDlpRule(rule)}
                          aria-label={t("移除规则 {rule}", { rule })}
                          className="ml-0.5 inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-black/10 dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <X size={11} aria-hidden />
                        </button>
                      )}
                    </span>
                  );
                })
              )}
            </div>
          </div>

          {/* Action, Public Share Scan, and Retention Controls */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-foreground">{t("命中处置动作")}</p>
              <FeishuSelect
                ariaLabel={t("命中处置动作")}
                value={dlpAction}
                options={dlpActionOptions}
                disabled={!canAdmin || savingPolicy}
                onChange={(val) =>
                  updateDraft({ dlpAction: val === "block" ? "block" : "warn" })
                }
                className="h-9 w-full border"
                menuMinWidth={200}
                dataAttr={{ "data-dlp-action-select": true }}
              />
              <label className="mt-2 inline-flex cursor-pointer items-center gap-2 pt-0.5 text-[13px] select-none">
                <input
                  type="checkbox"
                  checked={dlpBlockPublicShare}
                  disabled={!canAdmin || savingPolicy}
                  onChange={(e) => updateDraft({ dlpBlockPublicShare: e.target.checked })}
                  data-dlp-block-public-share=""
                  className="h-4 w-4 rounded border-border accent-primary"
                />
                <span>{t("对外公开分享时自动扫描文档内容")}</span>
              </label>
            </div>

            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-foreground">{t("回收站与审计数据保留周期")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[140px] flex-1">
                  <FeishuSelect
                    ariaLabel={t("回收站与审计数据保留周期")}
                    value={String(retentionDays)}
                    options={retentionOptions}
                    disabled={!canAdmin || savingPolicy}
                    onChange={(val) => {
                      const parsed = Number.parseInt(val, 10);
                      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 3650) {
                        updateDraft({ retentionDays: parsed });
                      }
                    }}
                    className="h-9 w-full border"
                    menuMinWidth={180}
                    dataAttr={{ "data-retention-days-select": true }}
                  />
                </div>
                <button
                  type="button"
                  disabled={!canAdmin || savingPolicy || runningRetention || retentionDays <= 0}
                  onClick={() => void handleRunRetentionPurge()}
                  data-retention-run-btn=""
                  className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border bg-surface px-3 text-[12px] font-medium transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 size={13} aria-hidden />
                  {runningRetention ? t("清理中…") : t("立即执行清理")}
                </button>
              </div>
              <p className="text-[11px] text-subtle">
                {t("设置回收站文档与企业安全审计日志的合规保留期限，选择永久保留则不自动清理。")}
              </p>
              {retentionError && (
                <p className="text-[12px] text-destructive" role="alert" data-retention-run-error="">
                  {retentionError}
                </p>
              )}
              {retentionResult && (
                <p
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-[#008026] dark:text-[#52c41a]"
                  role="status"
                  data-retention-run-result=""
                >
                  <CheckCircle2 size={13} aria-hidden />
                  {t("数据保留清理完成：已清理 {logs} 条审计日志、{nodes} 个过期回收站节点", {
                    logs: retentionResult.purgedAuditLogs,
                    nodes: retentionResult.purgedTrashNodes,
                  })}
                </p>
              )}
            </div>
          </div>

          {/* Compact Rule Live Test Sandbox */}
          <div className="space-y-2 rounded-md border bg-background/60 p-3" data-dlp-test-box="">
            <div className="flex items-center justify-between text-[12px]">
              <label htmlFor="org-dlp-test-input" className="font-medium text-foreground">
                {t("规则实测")}
              </label>
              <span className="text-subtle">
                {t("使用当前规则列表即时验证文本命中情况")}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="org-dlp-test-input"
                type="text"
                value={dlpTestInput}
                disabled={!canAdmin || testingDlp}
                onChange={(e) => setDlpTestInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleTestDlp();
                  }
                }}
                placeholder={t("输入测试文本，例如：内部机密项目联系人 13800138000")}
                data-dlp-test-input=""
                className="h-8 min-w-[220px] flex-1 rounded-md border bg-surface px-2.5 text-[13px] placeholder:text-subtle disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="button"
                disabled={!canAdmin || testingDlp}
                onClick={() => void handleTestDlp()}
                data-dlp-test-btn=""
                className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border bg-surface px-3 text-[12px] font-medium transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Search size={13} aria-hidden />
                {testingDlp ? t("检测中…") : t("立即检测")}
              </button>
            </div>

            {dlpTestError && (
              <p className="text-[12px] text-destructive" role="alert">
                {dlpTestError}
              </p>
            )}

            {dlpTestResult && (
              <div className="pt-1" data-dlp-test-result="">
                {dlpTestResult.matched ? (
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
                          dlpTestResult.action === "block"
                            ? "bg-[#fde2e2] text-[#d83931] dark:bg-[#4c1d1d] dark:text-[#ff7875]"
                            : "bg-[#fff3e0] text-[#c26a00] dark:bg-[#4a2f0b] dark:text-[#ffb74d]",
                        )}
                      >
                        <ShieldAlert size={12} aria-hidden />
                        {t("命中 {count} 处敏感内容", { count: dlpTestResult.matches.length })}
                      </span>
                      {dlpTestResult.matches.map((m, idx) => (
                        <span
                          key={`${m.rule}-${idx}`}
                          title={m.snippet}
                          className="inline-flex items-center gap-1 rounded-full border border-[#f5c2c7] bg-[#fff5f5] px-2 py-0.5 text-[11px] text-[#b42318] dark:border-[#7f1d1d] dark:bg-[#3b1518] dark:text-[#fca5a5]"
                        >
                          <span className="font-mono">{m.rule}</span>
                          <span>→</span>
                          <span className="font-medium">{m.match}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="inline-flex items-center gap-1 text-[12px] font-medium text-[#008026] dark:text-[#52c41a]">
                    <CheckCircle2 size={13} aria-hidden />
                    {t("未命中敏感规则")}
                  </p>
                )}
              </div>
            )}
          </div>

          {!canAdmin && (
            <p className="text-[12px] text-subtle">
              {t("仅空间所有者或管理员可修改企业 DLP 与保留策略。")}
            </p>
          )}
        </div>
      </section>

      {/* Section 2.5: Workspace Storage Usage, Quota Enforcement & Attachment Full-Text Index */}
      {canAdmin && (
        <section className="rounded-lg border bg-surface p-4" data-storage-usage-card="">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
            <div>
              <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">
                <HardDrive size={16} className="text-primary" aria-hidden />
                {t("存储空间与附件索引")}
              </h2>
              <p className="mt-0.5 text-[12px] text-subtle">
                {t("监控空间附件存储用量、配置存储容量配额，并一键回溯重建附件与图片 OCR 全文索引。")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void storageQuery.refetch()}
                disabled={storageQuery.isFetching}
                data-storage-refresh=""
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-surface px-2.5 text-[12px] transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw
                  size={13}
                  className={cn(storageQuery.isFetching && "animate-spin")}
                  aria-hidden
                />
                {t("刷新")}
              </button>
              <button
                type="button"
                onClick={() => void handleReindexAttachments()}
                disabled={reindexing}
                data-storage-reindex-btn=""
                className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border bg-surface px-3 text-[12px] font-medium transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Database
                  size={13}
                  className={cn(reindexing && "animate-pulse")}
                  aria-hidden
                />
                {reindexing ? t("重建中…") : t("重建附件全文索引")}
              </button>
            </div>
          </div>

          <div className="mt-4 space-y-4">
            {storageQuery.isLoading ? (
              <p className="py-4 text-[13px] text-subtle">{t("正在加载存储空间用量…")}</p>
            ) : storageQuery.isError ? (
              <p className="py-2 text-[13px] text-destructive" role="alert">
                {storageQuery.error instanceof Error
                  ? storageQuery.error.message
                  : t("加载存储空间用量失败")}
              </p>
            ) : (
              <>
                {/* Usage bar + attachment index coverage */}
                <div className="rounded-md border bg-background/60 p-3.5 space-y-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-[12px] font-medium text-subtle">{t("已用空间")}</span>
                      <span className="font-mono text-[15px] font-semibold text-foreground" data-storage-used-label="">
                        {formatStorageBytes(storageUsedBytes)}
                      </span>
                      <span className="text-[13px] text-subtle">/</span>
                      <span className="font-mono text-[13px] text-muted-foreground" data-storage-quota-label="">
                        {storageQuotaBytes > 0 ? formatStorageBytes(storageQuotaBytes) : t("无限制")}
                      </span>
                      {storageQuotaBytes > 0 && (
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 font-mono text-[11px] font-medium",
                            storagePercent >= 95
                              ? "bg-[#fde2e2] text-[#d83931] dark:bg-[#4c1d1d] dark:text-[#ff7875]"
                              : storagePercent > 80
                                ? "bg-[#fff3e0] text-[#c26a00] dark:bg-[#4a2f0b] dark:text-[#ffb74d]"
                                : "bg-[#e1eaff] text-[#1456f0] dark:bg-[#1d3461] dark:text-[#6698ff]",
                          )}
                        >
                          {t("已用 {percent}%", { percent: storagePercent })}
                        </span>
                      )}
                    </div>
                    <span
                      className="inline-flex items-center gap-1 rounded-full border bg-surface px-2.5 py-0.5 text-[12px] text-muted-foreground"
                      data-storage-indexed-badge=""
                    >
                      <Database size={12} className="text-primary" aria-hidden />
                      {t("已索引 {indexed} / {total} 个附件", {
                        indexed: storageUsage?.indexedCount ?? 0,
                        total: storageUsage?.attachmentCount ?? 0,
                      })}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div
                    role="progressbar"
                    aria-label={t("存储用量占比")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={storageQuotaBytes > 0 ? storageBarPercent : 0}
                    data-storage-progress=""
                    className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        storageQuotaBytes <= 0
                          ? "bg-primary/35"
                          : storagePercent >= 95
                            ? "bg-[#d83931] dark:bg-[#ff7875]"
                            : storagePercent > 80
                              ? "bg-[#de7802] dark:bg-[#ffb74d]"
                              : "bg-primary",
                      )}
                      style={{
                        width:
                          storageQuotaBytes > 0
                            ? `${Math.max(storageUsedBytes > 0 ? 2 : 0, storageBarPercent)}%`
                            : storageUsedBytes > 0
                              ? "18%"
                              : "0%",
                      }}
                    />
                  </div>

                  {storageQuotaBytes > 0 && storagePercent >= 95 && (
                    <p className="text-[12px] font-medium text-[#d83931] dark:text-[#ff7875]">
                      {t("配额即将耗尽：空间用量已达 95% 以上")}
                    </p>
                  )}
                  {storageQuotaBytes > 0 && storagePercent > 80 && storagePercent < 95 && (
                    <p className="text-[12px] font-medium text-[#c26a00] dark:text-[#ffb74d]">
                      {t("高水位告警：空间用量已超过 80%")}
                    </p>
                  )}

                  {/* Kind breakdown pills */}
                  <div className="pt-1">
                    <p className="mb-1.5 text-[11px] font-medium text-subtle">{t("按类型分布")}</p>
                    {(storageUsage?.byKind ?? []).length === 0 ? (
                      <span className="text-[12px] text-subtle">{t("暂无附件占用记录")}</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5" data-storage-by-kind="">
                        {(storageUsage?.byKind ?? []).map((bk) => (
                          <span
                            key={bk.kind}
                            className="inline-flex items-center gap-1.5 rounded-full border bg-surface px-2.5 py-0.5 text-[12px] text-foreground"
                          >
                            <span className="font-medium">{formatAuditResourceTypeLabel(bk.kind)}</span>
                            <span className="font-mono text-[11px] text-subtle">
                              {bk.count} · {formatStorageBytes(bk.bytes)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Reindex feedback */}
                {reindexError && (
                  <p className="text-[12px] text-destructive" role="alert" data-storage-reindex-error="">
                    {reindexError}
                  </p>
                )}
                {reindexResult && (
                  <p
                    className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#008026] dark:text-[#52c41a]"
                    role="status"
                    data-storage-reindex-result=""
                  >
                    <CheckCircle2 size={13} aria-hidden />
                    {t("附件索引重建完成：扫描 {scanned} 个、成功索引 {indexed} 个、跳过 {skipped} 个、失败 {failed} 个", {
                      scanned: reindexResult.scanned,
                      indexed: reindexResult.indexed,
                      skipped: reindexResult.skipped,
                      failed: reindexResult.failed,
                    })}
                  </p>
                )}

                {/* Top largest attachments list */}
                {(storageUsage?.topAttachments ?? []).length > 0 && (
                  <div className="space-y-1.5" data-storage-top-attachments="">
                    <p className="text-[12px] font-medium text-foreground">
                      {t("最大附件 Top {count}", { count: storageUsage!.topAttachments.length })}
                    </p>
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full min-w-[520px] border-collapse text-left text-[12px]">
                        <thead>
                          <tr className="border-b bg-muted/50 text-[11px] text-muted-foreground">
                            <th className="px-3 py-1.5 font-medium">{t("文件名")}</th>
                            <th className="px-3 py-1.5 font-medium">{t("所属文档")}</th>
                            <th className="px-3 py-1.5 text-right font-medium">{t("大小")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {storageUsage!.topAttachments.map((att) => (
                            <tr
                              key={att.id}
                              className="border-b last:border-b-0 transition-colors hover:bg-hover/40"
                            >
                              <td className="max-w-[220px] px-3 py-1.5">
                                <div className="truncate font-medium text-foreground" title={att.name}>
                                  {att.name}
                                </div>
                                {att.mime && (
                                  <div className="truncate font-mono text-[10px] text-subtle">
                                    {att.mime}
                                  </div>
                                )}
                              </td>
                              <td className="max-w-[200px] px-3 py-1.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                    {formatAuditResourceTypeLabel(att.docKind)}
                                  </span>
                                  <span className="truncate text-muted-foreground" title={att.docTitle}>
                                    {att.docTitle || `#${att.docId}`}
                                  </span>
                                </div>
                              </td>
                              <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-foreground">
                                {formatStorageBytes(att.size)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Quota configuration control */}
                <div className="space-y-2 rounded-md border bg-background/60 p-3">
                  <p className="text-[12px] font-medium text-foreground">{t("空间存储配额")}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="w-[140px]">
                      <FeishuSelect
                        ariaLabel={t("选择存储配额单位")}
                        value={quotaUnit}
                        options={quotaUnitOptions}
                        disabled={savingQuota}
                        onChange={(val) => {
                          const next: StorageQuotaUnit =
                            val === "MB" || val === "GB" ? val : "unlimited";
                          setQuotaUnitOverride(next);
                          setQuotaError("");
                          setQuotaNotice("");
                        }}
                        className="h-9 w-full border"
                        menuMinWidth={140}
                        dataAttr={{ "data-storage-quota-unit-select": true }}
                      />
                    </div>
                    {quotaUnit !== "unlimited" && (
                      <input
                        type="number"
                        min={1}
                        step="any"
                        value={quotaAmount}
                        disabled={savingQuota}
                        aria-label={t("输入配额数值")}
                        placeholder={t("输入配额数值")}
                        onChange={(e) => {
                          setQuotaAmountOverride(e.target.value);
                          setQuotaError("");
                          setQuotaNotice("");
                        }}
                        data-storage-quota-input=""
                        className="h-9 w-[140px] rounded-md border bg-surface px-3 font-mono text-[13px] placeholder:text-subtle disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    )}
                    <button
                      type="button"
                      disabled={savingQuota}
                      onClick={() => void handleSaveQuota()}
                      data-storage-quota-save=""
                      className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Save size={13} aria-hidden />
                      {savingQuota ? t("保存中…") : t("保存配额")}
                    </button>
                  </div>
                  <p className="text-[11px] text-subtle">
                    {t("达到配额上限后，新上传的云盘文件与文档附件将被拦截，设为「不限制」则不设上限。")}
                  </p>
                  {quotaError && (
                    <p className="text-[12px] text-destructive" role="alert" data-storage-quota-error="">
                      {quotaError}
                    </p>
                  )}
                  {quotaNotice && (
                    <p
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-[#008026] dark:text-[#52c41a]"
                      role="status"
                      data-storage-quota-notice=""
                    >
                      <CheckCircle2 size={13} aria-hidden />
                      {quotaNotice}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {/* Section 3: Enterprise Security Audit Logs */}
      <section className="rounded-lg border bg-surface p-4" data-audit-logs-section="">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">
              <Shield size={16} className="text-primary" aria-hidden />
              {t("企业安全审计日志")}
            </h2>
            <p className="mt-0.5 text-[12px] text-subtle">
              {t("记录登录认证、文档生命周期、权限共享与组织策略变更，支持多维筛选与 CSV 审计导出。")}
            </p>
          </div>
          {canAdmin && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void auditQuery.refetch()}
                disabled={auditQuery.isFetching}
                data-audit-refresh=""
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-surface px-2.5 text-[12px] transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw
                  size={13}
                  className={cn(auditQuery.isFetching && "animate-spin")}
                  aria-hidden
                />
                {t("刷新")}
              </button>
              <button
                type="button"
                onClick={() => void handleExportCsv()}
                disabled={exportingCsv}
                data-audit-export=""
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-surface px-3 text-[12px] font-medium transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download size={13} aria-hidden />
                {exportingCsv ? t("导出中…") : t("导出 CSV")}
              </button>
            </div>
          )}
        </div>

        {!canAdmin ? (
          <div className="py-10 text-center" data-audit-forbidden="">
            <ShieldAlert size={22} className="mx-auto mb-2 text-subtle" aria-hidden />
            <p className="text-[14px] font-medium">{t("仅空间所有者或管理员可查看安全审计日志")}</p>
            <p className="mt-1 text-[12px] text-subtle">
              {t("如需核查成员登录、共享变更或导出审计记录，请联系空间管理员。")}
            </p>
          </div>
        ) : (
          <>
            {/* Filter toolbar */}
            <div className="mt-3 flex flex-wrap items-center gap-2" data-audit-filter-bar="">
              <div className="relative min-w-[220px] flex-1">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle"
                  aria-hidden
                />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => {
                    setSearchInput(e.target.value);
                    setPage(0);
                  }}
                  placeholder={t("搜索操作人、邮箱、资源名称、操作类型或 IP")}
                  aria-label={t("搜索审计日志")}
                  data-audit-search=""
                  className="h-8 w-full rounded-md border bg-surface pl-8 pr-3 text-[13px] placeholder:text-subtle"
                />
              </div>

              <FeishuSelect
                ariaLabel={t("按操作类型筛选")}
                value={actionFilter}
                options={actionOptions}
                onChange={(val) => {
                  setActionFilter(val);
                  setPage(0);
                }}
                className="min-w-[148px] border"
                menuMinWidth={168}
                dataAttr={{ "data-audit-action-select": true }}
              />

              <FeishuSelect
                ariaLabel={t("按资源类型筛选")}
                value={resourceFilter}
                options={resourceOptions}
                onChange={(val) => {
                  setResourceFilter(val);
                  setPage(0);
                }}
                className="min-w-[136px] border"
                menuMinWidth={150}
                dataAttr={{ "data-audit-resource-select": true }}
              />
            </div>

            {/* Table */}
            <div className="mt-3 overflow-x-auto rounded-md border" data-audit-table-wrap="">
              <table className="w-full min-w-[720px] border-collapse text-left text-[13px]" data-audit-table="">
                <thead>
                  <tr className="border-b bg-muted/50 text-[12px] text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{t("时间")}</th>
                    <th className="px-3 py-2 font-medium">{t("操作人")}</th>
                    <th className="px-3 py-2 font-medium">{t("操作类型")}</th>
                    <th className="px-3 py-2 font-medium">{t("操作资源")}</th>
                    <th className="px-3 py-2 font-medium">{t("来源 IP")}</th>
                  </tr>
                </thead>
                <tbody>
                  {auditQuery.isLoading ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-[13px] text-subtle">
                        {t("正在加载审计日志…")}
                      </td>
                    </tr>
                  ) : auditQuery.isError ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-[13px] text-destructive">
                        {auditQuery.error instanceof Error
                          ? auditQuery.error.message
                          : t("加载审计日志失败")}
                      </td>
                    </tr>
                  ) : items.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-10 text-center text-subtle">
                        <FileSearch size={20} className="mx-auto mb-1.5 opacity-60" aria-hidden />
                        <p className="text-[13px]">{t("暂无匹配的审计日志")}</p>
                      </td>
                    </tr>
                  ) : (
                    items.map((entry) => (
                      <tr
                        key={entry.id}
                        data-audit-row={entry.id}
                        className="border-b last:border-b-0 transition-colors hover:bg-hover/50"
                      >
                        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[12px] text-muted-foreground">
                          {formatAuditTime(entry.createdAt)}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-foreground">
                            {entry.actorName || t("系统")}
                          </div>
                          {entry.actorEmail && (
                            <div className="text-[11px] text-subtle">{entry.actorEmail}</div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <span
                            title={entry.action}
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                              actionBadgeTone(entry.action),
                            )}
                          >
                            {formatAuditActionLabel(entry.action)}
                          </span>
                        </td>
                        <td className="max-w-[260px] px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {formatAuditResourceTypeLabel(entry.resourceType)}
                            </span>
                            <span
                              className="truncate text-foreground"
                              title={entry.resourceTitle || (entry.resourceId ? `#${entry.resourceId}` : "")}
                            >
                              {entry.resourceTitle || (entry.resourceId ? `#${entry.resourceId}` : "-")}
                            </span>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[12px] text-muted-foreground">
                          {entry.ipAddress || "-"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div
              className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground"
              data-audit-pagination=""
            >
              <span>{t("共 {total} 条记录", { total })}</span>
              <div className="flex items-center gap-2">
                <span>
                  {page + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={!hasPrev}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  data-audit-prev=""
                  className="h-7 cursor-pointer rounded-md border bg-surface px-2.5 text-[12px] text-foreground transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t("上一页")}
                </button>
                <button
                  type="button"
                  disabled={!hasNext}
                  onClick={() => setPage((p) => p + 1)}
                  data-audit-next=""
                  className="h-7 cursor-pointer rounded-md border bg-surface px-2.5 text-[12px] text-foreground transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t("下一页")}
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
