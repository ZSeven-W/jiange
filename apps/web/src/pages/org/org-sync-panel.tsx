import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FileUp, KeyRound, Play, Plus, RefreshCw, ShieldAlert, Sparkles, Trash2 } from "lucide-react";
import {
  ApiError,
  orgSyncApi,
  type OrgDirectorySyncPayload,
  type OrgSyncDeptInput,
  type OrgSyncGroupInput,
  type OrgSyncMemberInput,
  type OrgSyncProvider,
  type OrgSyncRun,
  type OrgSyncSource,
} from "@/lib/api";
import { ask } from "@/components/ui/ask";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const PROVIDER_LABELS: Record<OrgSyncProvider, string> = {
  scim: "SCIM 2.0",
  ldap: "LDAP / AD",
  wecom: "企业微信",
  dingtalk: "钉钉",
  custom: "自定义 Webhook",
};

const TRIGGER_LABELS: Record<OrgSyncRun["triggerMode"], string> = {
  manual: "手动导入",
  push: "Webhook 推送",
  scim: "SCIM 2.0",
};

export const SAMPLE_ORG_DIRECTORY_CSV = [
  "部门路径,姓名,邮箱,角色,用户组,负责人",
  "研发中心/基础架构部,林晓,linxiao@example.com,admin,核心架构组;安全审计组,是",
  "研发中心/云文档部,陈明,chenming@example.com,member,核心架构组,否",
  "产品设计部/交互组,周瑶,zhouyao@example.com,member,产品评审组,是",
].join("\n");

export const SAMPLE_ORG_DIRECTORY_JSON = JSON.stringify(
  {
    departments: [
      { externalId: "dept-rnd", name: "研发中心", sortOrder: 1 },
      { externalId: "dept-infra", parentExternalId: "dept-rnd", name: "基础架构部", sortOrder: 1 },
      { externalId: "dept-docs", parentExternalId: "dept-rnd", name: "云文档部", sortOrder: 2 },
    ],
    groups: [
      { externalId: "grp-arch", name: "核心架构组", description: "跨部门架构评审" },
    ],
    members: [
      {
        email: "linxiao@example.com",
        name: "林晓",
        role: "admin",
        departmentExternalIds: ["dept-infra"],
        leaderDepartmentExternalIds: ["dept-infra"],
        groupExternalIds: ["grp-arch"],
      },
    ],
  },
  null,
  2,
);

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (line[i + 1] === "\"") {
          cur += "\"";
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === "\"") {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function splitMulti(raw: string): string[] {
  return raw
    .split(/[;；|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isTruthyFlag(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "是" || v === "true" || v === "1" || v === "yes" || v === "leader" || v === "负责人";
}

function parseRoleValue(raw: string): "" | "member" | "admin" {
  const v = raw.trim().toLowerCase();
  if (v === "admin" || v === "管理员") return "admin";
  if (v === "member" || v === "普通成员" || v === "成员") return "member";
  return "";
}

/**
 * Parses an enterprise directory CSV (header: 部门路径,姓名,邮箱,角色,用户组,负责人)
 * into a deterministic, idempotent OrgDirectorySyncPayload.
 */
export function parseOrgDirectoryCsv(text: string): { payload: OrgDirectorySyncPayload; warnings: string[] } {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  if (lines.length === 0) {
    throw new Error("CSV 内容为空，请先填写或载入目录数据");
  }

  const firstCells = parseCsvLine(lines[0]).map((c) => c.toLowerCase());
  const hasHeader = firstCells.some((c) =>
    ["部门路径", "部门", "department", "departments", "邮箱", "email", "姓名", "name"].includes(c),
  );

  let colDept = 0;
  let colName = 1;
  let colEmail = 2;
  let colRole = 3;
  let colGroup = 4;
  let colLeader = 5;

  const dataLines = hasHeader ? lines.slice(1) : lines;
  if (hasHeader) {
    const findCol = (aliases: string[], fallback: number) => {
      const idx = firstCells.findIndex((c) => aliases.includes(c));
      return idx >= 0 ? idx : fallback;
    };
    colDept = findCol(["部门路径", "部门", "department", "departments"], -1);
    colName = findCol(["姓名", "name", "displayname"], -1);
    colEmail = findCol(["邮箱", "email", "mail"], -1);
    colRole = findCol(["角色", "role"], -1);
    colGroup = findCol(["用户组", "群组", "group", "groups"], -1);
    colLeader = findCol(["负责人", "部门负责人", "leader", "isleader"], -1);
  }

  const departments: OrgSyncDeptInput[] = [];
  const deptSeen = new Set<string>();
  const groups: OrgSyncGroupInput[] = [];
  const groupSeen = new Set<string>();
  const memberByEmail = new Map<string, OrgSyncMemberInput>();
  const warnings: string[] = [];

  const ensureDeptPath = (path: string): string => {
    const segments = path
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) return "";
    let parentExternalId = "";
    let curExternalId = "";
    for (let i = 0; i < segments.length; i++) {
      curExternalId = `dept:${segments.slice(0, i + 1).join("/")}`;
      if (!deptSeen.has(curExternalId)) {
        deptSeen.add(curExternalId);
        departments.push({
          externalId: curExternalId,
          ...(parentExternalId ? { parentExternalId } : {}),
          name: segments[i],
          sortOrder: departments.length + 1,
        });
      }
      parentExternalId = curExternalId;
    }
    return curExternalId;
  };

  const ensureGroup = (name: string): string => {
    const extId = `csv-grp:${name}`;
    if (!groupSeen.has(extId)) {
      groupSeen.add(extId);
      groups.push({ externalId: extId, name });
    }
    return extId;
  };

  const readCell = (cells: string[], idx: number) => (idx >= 0 && idx < cells.length ? cells[idx] : "");

  for (let i = 0; i < dataLines.length; i++) {
    const cells = parseCsvLine(dataLines[i]);
    const deptPaths = splitMulti(readCell(cells, colDept));
    const name = readCell(cells, colName);
    const emailRaw = readCell(cells, colEmail);
    const role = parseRoleValue(readCell(cells, colRole));
    const groupNames = splitMulti(readCell(cells, colGroup));
    const leader = isTruthyFlag(readCell(cells, colLeader));

    const deptIds: string[] = [];
    for (const p of deptPaths) {
      const id = ensureDeptPath(p);
      if (id) deptIds.push(id);
    }
    const groupIds: string[] = [];
    for (const g of groupNames) {
      groupIds.push(ensureGroup(g));
    }

    const email = emailRaw.trim().toLowerCase();
    if (!email) {
      if (deptIds.length === 0 && groupIds.length === 0) {
        warnings.push(`第 ${i + (hasHeader ? 2 : 1)} 行缺少有效数据，已忽略`);
      }
      continue;
    }
    if (!email.includes("@")) {
      throw new Error(`第 ${i + (hasHeader ? 2 : 1)} 行邮箱格式无效：${emailRaw}`);
    }

    const existing = memberByEmail.get(email) ?? {
      email,
      name,
      role,
      departmentExternalIds: [],
      leaderDepartmentExternalIds: [],
      groupExternalIds: [],
    };
    if (!existing.name && name) existing.name = name;
    if (role === "admin" || (!existing.role && role)) existing.role = role;
    for (const did of deptIds) {
      if (!existing.departmentExternalIds!.includes(did)) {
        existing.departmentExternalIds!.push(did);
      }
      if (leader && !existing.leaderDepartmentExternalIds!.includes(did)) {
        existing.leaderDepartmentExternalIds!.push(did);
      }
    }
    for (const gid of groupIds) {
      if (!existing.groupExternalIds!.includes(gid)) {
        existing.groupExternalIds!.push(gid);
      }
    }
    memberByEmail.set(email, existing);
  }

  return {
    payload: {
      departments,
      groups,
      members: Array.from(memberByEmail.values()),
    },
    warnings,
  };
}

export function OrgSyncPanel({
  workspaceId,
  userId,
  canAdmin,
}: {
  workspaceId: number;
  userId: number;
  canAdmin: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [newName, setNewName] = useState("");
  const [newProvider, setNewProvider] = useState<OrgSyncProvider>("scim");
  const [newAutoInvite, setNewAutoInvite] = useState(true);
  const [newPruneMissing, setNewPruneMissing] = useState(false);

  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
  const [freshToken, setFreshToken] = useState<{ sourceName: string; token: string } | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [rawInput, setRawInput] = useState("");
  const [overridePrune, setOverridePrune] = useState(false);
  const [previewRun, setPreviewRun] = useState<OrgSyncRun | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const syncQueryKey = ["workspace-org-sync", workspaceId, userId];
  const orgQueryKey = ["workspace-org", workspaceId, userId];

  const syncQuery = useQuery({
    queryKey: syncQueryKey,
    queryFn: () => orgSyncApi.state(workspaceId, userId),
    enabled: canAdmin && workspaceId > 0,
  });

  const sources = syncQuery.data?.sources ?? [];
  const runs = syncQuery.data?.runs ?? [];

  const activeSource: OrgSyncSource | null = useMemo(() => {
    if (!sources.length) return null;
    return sources.find((s) => s.id === selectedSourceId) ?? sources[0];
  }, [sources, selectedSourceId]);

  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-jiange.example";

  const withFeedback = async (fn: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else if (e instanceof Error) setError(e.message);
      else setError(t("操作失败，请检查后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopiedToken(true);
      window.setTimeout(() => setCopiedToken(false), 2000);
    } catch {
      setCopiedToken(false);
    }
  };

  const buildPayload = (dryRun: boolean): OrgDirectorySyncPayload => {
    setParseWarnings([]);
    const trimmed = rawInput.trim();
    if (!trimmed) {
      throw new Error(t("请先输入或导入目录快照数据"));
    }
    if (format === "csv") {
      const parsed = parseOrgDirectoryCsv(trimmed);
      setParseWarnings(parsed.warnings);
      return {
        ...parsed.payload,
        dryRun,
        ...(overridePrune ? { pruneMissing: true } : {}),
      };
    }
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      throw new Error(t("JSON 语法无效，请检查格式"));
    }
    if (!obj || typeof obj !== "object") {
      throw new Error(t("JSON 内容必须是对象"));
    }
    const base = obj as Record<string, unknown>;
    return {
      ...(base as unknown as OrgDirectorySyncPayload),
      dryRun,
      ...(overridePrune ? { pruneMissing: true } : {}),
    };
  };

  const handleExecuteSync = (dryRun: boolean) => {
    if (!activeSource) return;
    void withFeedback(async () => {
      const payload = buildPayload(dryRun);
      const run = await orgSyncApi.run(workspaceId, activeSource.id, userId, payload);
      setPreviewRun(run);
      await qc.invalidateQueries({ queryKey: syncQueryKey });
      if (!dryRun) {
        await qc.invalidateQueries({ queryKey: orgQueryKey });
        return t("目录同步已完成，部门、用户组与成员邀请已生效");
      }
      return t("差异预演完成（未修改现有组织数据）");
    });
  };

  const handleFilePick = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const isJson = file.name.toLowerCase().endsWith(".json") || text.trim().startsWith("{");
    setFormat(isJson ? "json" : "csv");
    setRawInput(text);
    setPreviewRun(null);
    setError("");
  };

  if (!canAdmin) {
    return (
      <section className="rounded-lg border bg-surface p-6 text-center" data-org-sync-panel>
        <ShieldAlert size={22} className="mx-auto mb-2 text-subtle" />
        <p className="text-[14px] font-medium">{t("仅空间所有者或管理员可管理外部目录同步")}</p>
        <p className="mt-1 text-[12px] text-subtle">
          {t("支持通过 SCIM 2.0、LDAP、企业微信/钉钉 Webhook 或 CSV/JSON 快照增量同步部门架构与用户组。")}
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4" data-org-sync-panel>
      {error && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-[13px] text-primary">
          {notice}
        </p>
      )}

      {freshToken && (
        <section
          data-sync-token-banner
          className="rounded-lg border border-primary/40 bg-primary/5 p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[14px] font-semibold text-primary">
                <KeyRound size={15} />
                {t("同步源「{name}」凭证已生成（仅展示一次）", { name: freshToken.sourceName })}
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {t("请立即保存该 Bearer Token，用于外部 IdP / SCIM 2.0 推送至 /api/org/sync/push。")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setFreshToken(null)}
              className="h-7 rounded-md border bg-surface px-2.5 text-[12px] hover:bg-hover"
            >
              {t("我已保存")}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code
              data-sync-token-value
              className="min-w-0 flex-1 overflow-x-auto rounded border bg-surface px-2.5 py-1.5 font-mono text-[12px] select-all"
            >
              {freshToken.token}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyToken(freshToken.token)}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border bg-surface px-2.5 text-[12px] hover:bg-hover"
            >
              {copiedToken ? <Check size={13} className="text-primary" /> : <Copy size={13} />}
              {copiedToken ? t("已复制") : t("复制 Token")}
            </button>
          </div>
          <pre className="mt-2.5 overflow-x-auto rounded border bg-surface p-2.5 font-mono text-[11px] text-muted-foreground">
{`curl -X POST "${origin}/api/org/sync/push" \\
  -H "Authorization: Bearer ${freshToken.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"departments":[{"externalId":"rnd","name":"研发中心"}],"groups":[],"members":[]}'`}
          </pre>
        </section>
      )}

      {/* Connector setup & list */}
      <section className="rounded-lg border bg-surface p-4">
        <div className="border-b pb-3">
          <h2 className="text-[15px] font-semibold">{t("外部组织目录同步源")}</h2>
          <p className="mt-0.5 text-[12px] text-subtle">
            {t("对接 SCIM 2.0 / LDAP / 企业微信 / 钉钉推送或手动导入 CSV/JSON 快照；未加入空间的成员仅发送邀请，不绕过用户同意。")}
          </p>
        </div>

        <form
          data-sync-create-form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            void withFeedback(async () => {
              const created = await orgSyncApi.createSource(workspaceId, userId, {
                name: newName.trim(),
                provider: newProvider,
                autoInviteMissing: newAutoInvite,
                pruneMissing: newPruneMissing,
              });
              setNewName("");
              setSelectedSourceId(created.source.id);
              if (created.token) {
                setFreshToken({ sourceName: created.source.name, token: created.token });
              }
              await qc.invalidateQueries({ queryKey: syncQueryKey });
              return t("目录同步源已创建");
            });
          }}
        >
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("同步源名称（如 Okta SCIM / 企业微信）")}
            data-sync-source-name
            className="h-9 min-w-44 flex-1 rounded-md border bg-surface px-3 text-[13px]"
          />
          <select
            aria-label={t("同步协议类型")}
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value as OrgSyncProvider)}
            data-sync-provider-select
            className="h-9 rounded-md border bg-surface px-2.5 text-[13px]"
          >
            {(Object.keys(PROVIDER_LABELS) as OrgSyncProvider[]).map((k) => (
              <option key={k} value={k}>
                {t(PROVIDER_LABELS[k])}
              </option>
            ))}
          </select>
          <label className="inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-[12px] text-muted-foreground">
            <input type="checkbox" checked={newAutoInvite} onChange={(e) => setNewAutoInvite(e.target.checked)} />
            {t("自动邀请未加入邮箱")}
          </label>
          <label className="inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-[12px] text-muted-foreground">
            <input type="checkbox" checked={newPruneMissing} onChange={(e) => setNewPruneMissing(e.target.checked)} />
            {t("清理缺失项")}
          </label>
          <button
            type="submit"
            disabled={busy || !newName.trim()}
            data-sync-create-btn
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={14} />
            {t("新建同步源")}
          </button>
        </form>

        <div className="mt-4 space-y-2" data-sync-source-list>
          {syncQuery.isPending ? (
            <p className="py-4 text-center text-[13px] text-subtle">{t("正在加载同步配置…")}</p>
          ) : sources.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-subtle">{t("尚未配置外部目录同步源，请先在上方创建一个连接器")}</p>
          ) : (
            sources.map((src) => {
              const selected = activeSource?.id === src.id;
              return (
                <div
                  key={src.id}
                  data-sync-source-card={src.id}
                  className={cn(
                    "flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2.5 transition-colors",
                    selected ? "border-primary/50 bg-primary/5" : "bg-surface",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSourceId(src.id);
                      setPreviewRun(null);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[14px] font-medium">{src.name}</span>
                      <span className="rounded bg-sidebar px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t(PROVIDER_LABELS[src.provider] ?? "自定义 Webhook")}
                      </span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[11px]",
                          src.enabled ? "bg-primary/10 text-primary" : "bg-sidebar text-subtle",
                        )}
                      >
                        {src.enabled ? t("已启用") : t("已停用")}
                      </span>
                      {src.autoInviteMissing && (
                        <span className="rounded border px-1.5 py-0.5 text-[11px] text-subtle">{t("自动邀请")}</span>
                      )}
                      {src.pruneMissing && (
                        <span className="rounded border px-1.5 py-0.5 text-[11px] text-subtle">{t("清理缺失")}</span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-[12px] text-subtle">
                      Token: <code className="font-mono">{src.tokenPrefix}</code>
                      {src.lastSummary ? ` · ${src.lastSummary}` : ` · ${t("尚未执行同步")}`}
                    </p>
                  </button>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void withFeedback(async () => {
                          await orgSyncApi.updateSource(workspaceId, src.id, userId, { enabled: !src.enabled });
                          await qc.invalidateQueries({ queryKey: syncQueryKey });
                          return src.enabled ? t("已停用同步源") : t("已启用同步源");
                        })
                      }
                      className="h-7 rounded border px-2 text-[12px] hover:bg-hover disabled:opacity-50"
                    >
                      {src.enabled ? t("停用") : t("启用")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void withFeedback(async () => {
                          const ok = await ask(t("轮换同步凭证？"), t("旧的 Bearer Token 将立即失效，需更新外部推送配置。"));
                          if (!ok) return;
                          const rotated = await orgSyncApi.updateSource(workspaceId, src.id, userId, { rotateToken: true });
                          if (rotated.token) {
                            setFreshToken({ sourceName: rotated.source.name, token: rotated.token });
                          }
                          await qc.invalidateQueries({ queryKey: syncQueryKey });
                          return t("已生成新同步 Token");
                        })
                      }
                      className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[12px] hover:bg-hover disabled:opacity-50"
                    >
                      <RefreshCw size={11} />
                      {t("轮换 Token")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t("删除同步源")}
                      onClick={() =>
                        void withFeedback(async () => {
                          const ok = await ask(t("删除同步源「{name}」？", { name: src.name }), t("已同步的部门和用户组将被保留，但不再受该连接器托管。"));
                          if (!ok) return;
                          await orgSyncApi.deleteSource(workspaceId, src.id, userId);
                          if (selectedSourceId === src.id) setSelectedSourceId(null);
                          await qc.invalidateQueries({ queryKey: syncQueryKey });
                          return t("同步源已删除");
                        })
                      }
                      className="grid size-7 place-items-center rounded border text-subtle hover:bg-destructive/5 hover:text-destructive disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* Manual Snapshot Import & Dry-Run */}
      {activeSource && (
        <section className="rounded-lg border bg-surface p-4" data-sync-runner>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-semibold">
                {t("目录快照导入与预演")} · {activeSource.name}
              </h3>
              <p className="text-[12px] text-subtle">
                {t("建议先点击「预演差异」核对部门树、用户组与邀请变化，再正式执行同步。")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="inline-flex rounded-md border bg-sidebar p-0.5 text-[12px]">
                <button
                  type="button"
                  data-sync-format="csv"
                  onClick={() => setFormat("csv")}
                  className={cn("rounded px-2.5 py-1", format === "csv" ? "bg-surface font-medium shadow-xs" : "text-muted-foreground")}
                >
                  CSV
                </button>
                <button
                  type="button"
                  data-sync-format="json"
                  onClick={() => setFormat("json")}
                  className={cn("rounded px-2.5 py-1", format === "json" ? "bg-surface font-medium shadow-xs" : "text-muted-foreground")}
                >
                  JSON / SCIM
                </button>
              </div>
              <button
                type="button"
                data-sync-load-sample
                onClick={() => {
                  setRawInput(format === "csv" ? SAMPLE_ORG_DIRECTORY_CSV : SAMPLE_ORG_DIRECTORY_JSON);
                  setPreviewRun(null);
                  setError("");
                }}
                className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[12px] hover:bg-hover"
              >
                <Sparkles size={13} />
                {t("载入示例")}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[12px] hover:bg-hover"
              >
                <FileUp size={13} />
                {t("选择文件")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.json,text/csv,application/json"
                className="hidden"
                onChange={(e) => {
                  void handleFilePick(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          <textarea
            rows={7}
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            data-sync-input
            placeholder={
              format === "csv"
                ? t("部门路径,姓名,邮箱,角色,用户组,负责人（每行一条记录，部门可用 / 表示层级）")
                : t("粘贴标准目录 JSON 或 SCIM 2.0 ListResponse JSON…")
            }
            className="mt-3 w-full rounded-md border bg-canvas p-3 font-mono text-[12px] leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary"
          />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <input type="checkbox" checked={overridePrune} onChange={(e) => setOverridePrune(e.target.checked)} />
              {t("本次同步清理快照中缺失的已托管部门与用户组（不影响手工创建的部门）")}
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || !rawInput.trim()}
                data-sync-dry-run-btn
                onClick={() => handleExecuteSync(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium hover:bg-hover disabled:opacity-50"
              >
                {t("预演差异")}
              </button>
              <button
                type="button"
                disabled={busy || !rawInput.trim()}
                data-sync-apply-btn
                onClick={() => handleExecuteSync(false)}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                <Play size={13} />
                {t("执行同步")}
              </button>
            </div>
          </div>

          {previewRun && (
            <div
              data-sync-preview-card
              className="mt-4 rounded-md border bg-sidebar/40 p-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-semibold">
                  {previewRun.dryRun ? t("差异预演结果（未落库）") : t("本次同步执行结果")}
                </span>
                <span className="rounded bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                  {t(TRIGGER_LABELS[previewRun.triggerMode] ?? "手动导入")}
                </span>
              </div>
              <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <div className="rounded border bg-surface px-2.5 py-2">
                  <p className="text-[11px] text-subtle">{t("部门变更")}</p>
                  <p className="mt-0.5 text-[13px] font-semibold">
                    +{previewRun.departmentsCreated} / ~{previewRun.departmentsUpdated} / -{previewRun.departmentsRemoved}
                  </p>
                </div>
                <div className="rounded border bg-surface px-2.5 py-2">
                  <p className="text-[11px] text-subtle">{t("用户组变更")}</p>
                  <p className="mt-0.5 text-[13px] font-semibold">
                    +{previewRun.groupsCreated} / ~{previewRun.groupsUpdated} / -{previewRun.groupsRemoved}
                  </p>
                </div>
                <div className="rounded border bg-surface px-2.5 py-2">
                  <p className="text-[11px] text-subtle">{t("成员匹配 / 邀请 / 归属")}</p>
                  <p className="mt-0.5 text-[13px] font-semibold">
                    {previewRun.membersLinked} / {previewRun.membersInvited} / {previewRun.membershipsUpdated}
                  </p>
                </div>
              </div>
              {[...parseWarnings, ...(previewRun.warnings ?? [])].length > 0 && (
                <ul className="mt-2.5 list-disc space-y-0.5 pl-4 text-[12px] text-muted-foreground">
                  {[...parseWarnings, ...(previewRun.warnings ?? [])].map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {/* Audit History */}
      <section className="rounded-lg border bg-surface p-4" data-sync-runs>
        <h3 className="border-b pb-2.5 text-[15px] font-semibold">{t("同步审计日志")}</h3>
        {runs.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-subtle">{t("暂无目录同步执行记录")}</p>
        ) : (
          <div className="mt-3 space-y-2">
            {runs.map((r) => (
              <div
                key={r.id}
                data-sync-run-row={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-[12px]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">{r.sourceName || `#${r.sourceId}`}</span>
                    <span className="rounded bg-sidebar px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {t(TRIGGER_LABELS[r.triggerMode] ?? "手动导入")}
                    </span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[11px]",
                        r.dryRun ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-primary/10 text-primary",
                      )}
                    >
                      {r.dryRun ? t("预演") : t("已执行")}
                    </span>
                  </div>
                  <p className="mt-0.5 text-subtle">
                    {t("部门 +{dc}/~{du}/-{dr} · 用户组 +{gc}/~{gu}/-{gr} · 匹配 {ml} · 邀请 {mi} · 归属变更 {mu}", {
                      dc: r.departmentsCreated,
                      du: r.departmentsUpdated,
                      dr: r.departmentsRemoved,
                      gc: r.groupsCreated,
                      gu: r.groupsUpdated,
                      gr: r.groupsRemoved,
                      ml: r.membersLinked,
                      mi: r.membersInvited,
                      mu: r.membershipsUpdated,
                    })}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-subtle">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
