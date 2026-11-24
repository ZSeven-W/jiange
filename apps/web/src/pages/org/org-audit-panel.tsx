import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  FileSearch,
  RefreshCw,
  Save,
  Search,
  Shield,
  ShieldAlert,
  Stamp,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  enterpriseApi,
  type AuditLogEntry,
  type AuditLogPage,
  type WorkspaceSecurityPolicy,
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
  "auth.logout",
  "doc.create",
  "doc.update",
  "doc.delete",
  "doc.restore",
  "share.update",
  "share.link_update",
  "org.member_update",
  "org.member_invite",
  "org.member_remove",
  "org.department_update",
  "org.group_update",
  "org.watermark_update",
  "org.sso_update",
  "org.sync_run",
  "base.permissions_update",
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
  if (action.endsWith(".delete") || action.endsWith(".remove")) {
    return "bg-[#fde2e2] text-[#d83931] dark:bg-[#4c1d1d] dark:text-[#ff7875]";
  }
  if (action.startsWith("audit.")) {
    return "bg-[#f0e6ff] text-[#6425d0] dark:bg-[#2d1e4f] dark:text-[#b388ff]";
  }
  if (action.startsWith("org.") || action.startsWith("share.") || action.includes("permissions")) {
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

  // Audit filter & pagination state
  const [searchInput, setSearchInput] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [resourceFilter, setResourceFilter] = useState("");
  const [page, setPage] = useState(0);

  // Reset local draft and filters when switching workspace
  useEffect(() => {
    setDraftOverride(null);
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

  const serverPolicy: WorkspaceSecurityPolicy = policyQuery.data ?? {
    workspaceId,
    watermarkEnabled: false,
    watermarkText: "",
    watermarkShowUser: true,
    watermarkShowEmail: true,
    watermarkShowDate: true,
    watermarkOpacity: DEFAULT_WATERMARK_OPACITY,
    updatedBy: 0,
    updatedAt: "",
  };

  const draft: WorkspaceSecurityPolicy = draftOverride
    ? { ...serverPolicy, ...draftOverride }
    : serverPolicy;

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
        },
        userId,
      );
      qc.setQueryData(policyKey, saved);
      setDraftOverride(null);
      await qc.invalidateQueries({ queryKey: ["workspace-audit-logs", workspaceId] });
      setNotice(t("安全水印策略已保存并同步至全套件"));
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else if (e instanceof Error) setError(e.message);
      else setError(t("保存失败"));
    } finally {
      setSavingPolicy(false);
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

      {/* Section 2: Enterprise Security Audit Logs */}
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
