import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  patApi,
  type CreatePATResult,
  type PATScope,
  type PersonalAccessToken,
} from "@/lib/security-api";
import { ask } from "@/components/ui/ask";
import { FeishuSelect, type FeishuSelectOption } from "@/components/feishu-select";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const PAT_QUERY_KEY = ["me", "personal-access-tokens"] as const;
export const PAT_MAX_ACTIVE = 50;

export type PATStatus = "active" | "expired" | "revoked";

const SCOPE_ORDER: readonly PATScope[] = ["read", "write", "admin"];

export function getPATStatus(
  token: Pick<PersonalAccessToken, "revokedAt" | "expiresAt">,
  now: Date = new Date(),
): PATStatus {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt) {
    const expMs = new Date(token.expiresAt).getTime();
    if (!Number.isNaN(expMs) && expMs <= now.getTime()) {
      return "expired";
    }
  }
  return "active";
}

export function togglePATScope(current: readonly PATScope[], target: PATScope): PATScope[] {
  const next = new Set<PATScope>(current);
  if (next.has(target)) {
    next.delete(target);
  } else {
    next.add(target);
  }
  return SCOPE_ORDER.filter((s) => next.has(s));
}

export function formatPATCurlExample(apiOrigin?: string): string {
  const base = apiOrigin?.trim().replace(/\/+$/, "") ?? "";
  const url = base ? `${base}/api/me` : "/api/me";
  return `curl -H "Authorization: Bearer jg_pat_..." ${url}`;
}

function formatPATDateTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatPATDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function scopePillTone(scope: PATScope): string {
  switch (scope) {
    case "admin":
      return "border-[#d8c4ff] bg-[#f4edff] text-[#6425d0] dark:border-[#4b2d80] dark:bg-[#2d1e4f] dark:text-[#c4a1ff]";
    case "write":
      return "border-[#ffd8a8] bg-[#fff4e6] text-[#c26a00] dark:border-[#6e4610] dark:bg-[#4a2f0b] dark:text-[#ffb74d]";
    case "read":
    default:
      return "border-[#c7dcff] bg-[#eef4ff] text-[#1456f0] dark:border-[#24427a] dark:bg-[#1d3461] dark:text-[#7aa7ff]";
  }
}

function statusPillTone(status: PATStatus): string {
  switch (status) {
    case "active":
      return "bg-[#e3f9e5] text-[#008026] dark:bg-[#143d1f] dark:text-[#52c41a]";
    case "expired":
      return "bg-[#fde2e2] text-[#d83931] dark:bg-[#4c1d1d] dark:text-[#ff7875]";
    case "revoked":
    default:
      return "bg-[#eff0f1] text-[#646a73] dark:bg-[#2f3238] dark:text-[#a6aab0]";
  }
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export interface PatManagerProps {
  /** Optional API origin used in the curl snippet; defaults to relative `/api/me`. */
  apiOrigin?: string;
  /** Optional initial newly-created token result (useful in tests and previews). */
  initialCreatedToken?: CreatePATResult | null;
  /** Optional extra wrapper className. */
  className?: string;
}

export function PatManager({
  apiOrigin,
  initialCreatedToken = null,
  className,
}: PatManagerProps = {}) {
  const { t } = useI18n();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<PATScope[]>(["read", "write"]);
  const [expiryDays, setExpiryDays] = useState<string>("90");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [createdToken, setCreatedToken] = useState<CreatePATResult | null>(initialCreatedToken);
  const [copiedRaw, setCopiedRaw] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!copiedRaw) return;
    const timer = window.setTimeout(() => setCopiedRaw(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedRaw]);

  useEffect(() => {
    if (!copiedCurl) return;
    const timer = window.setTimeout(() => setCopiedCurl(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedCurl]);

  const tokensQuery = useQuery<PersonalAccessToken[]>({
    queryKey: PAT_QUERY_KEY,
    queryFn: ({ signal }) => patApi.list(signal),
  });

  const tokens = tokensQuery.data ?? [];
  const activeCount = useMemo(
    () => tokens.filter((tok) => getPATStatus(tok) === "active").length,
    [tokens],
  );

  const expiryOptions: readonly FeishuSelectOption[] = useMemo(
    () => [
      { value: "30", label: t("30 天") },
      { value: "90", label: t("90 天") },
      { value: "365", label: t("1 年") },
      { value: "0", label: t("永不过期") },
    ],
    [t],
  );

  const curlSnippet = useMemo(() => formatPATCurlExample(apiOrigin), [apiOrigin]);

  const handleToggleScope = (scope: PATScope) => {
    setScopes((prev) => togglePATScope(prev, scope));
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (creating) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("请输入令牌名称"));
      return;
    }
    if (scopes.length === 0) {
      setError(t("请至少选择一个权限范围"));
      return;
    }

    setCreating(true);
    setError("");
    setNotice("");
    try {
      const days = Number(expiryDays);
      const res = await patApi.create({
        name: trimmed,
        scopes,
        expiresInDays: days > 0 ? days : null,
      });
      setCreatedToken(res);
      setCopiedRaw(false);
      setName("");
      await qc.invalidateQueries({ queryKey: PAT_QUERY_KEY });
      setNotice(t("访问令牌已生成"));
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError(t("创建访问令牌失败，请稍后重试"));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (token: PersonalAccessToken) => {
    if (revokingId !== null) return;
    const confirmed = await ask(
      t("吊销访问令牌「{name}」？", { name: token.name }),
      t("吊销后使用该令牌的脚本和接口请求将立即失效，且无法恢复。"),
    );
    if (!confirmed) return;

    setRevokingId(token.id);
    setError("");
    setNotice("");
    try {
      await patApi.revoke(token.id);
      if (createdToken?.token.id === token.id) {
        setCreatedToken(null);
      }
      await qc.invalidateQueries({ queryKey: PAT_QUERY_KEY });
      setNotice(t("访问令牌已吊销"));
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError(t("吊销访问令牌失败，请稍后重试"));
    } finally {
      setRevokingId(null);
    }
  };

  const handleCopyRaw = async () => {
    if (!createdToken) return;
    const ok = await copyText(createdToken.rawToken);
    if (ok) {
      setCopiedRaw(true);
    } else {
      setError(t("复制失败，请手动选中令牌内容复制"));
    }
  };

  const handleCopyCurl = async () => {
    const ok = await copyText(curlSnippet);
    if (ok) {
      setCopiedCurl(true);
    }
  };

  return (
    <div className={cn("space-y-4", className)} data-pat-manager="">
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

      {/* One-time created token banner */}
      {createdToken && (
        <section
          role="status"
          data-pat-created-banner=""
          className="rounded-lg border border-[#f59e0b]/45 bg-[#fffbeb] p-4 shadow-xs dark:border-[#b45309]/55 dark:bg-[#3a2a0a]/45"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-[#e3f9e5] text-[#008026] dark:bg-[#143d1f] dark:text-[#52c41a]">
                <ShieldCheck size={15} aria-hidden />
              </div>
              <div>
                <h3 className="text-[14px] font-semibold text-foreground">
                  {t("令牌「{name}」已生成", { name: createdToken.token.name })}
                </h3>
                <p className="mt-0.5 flex items-center gap-1.5 text-[12px] font-medium text-[#b45309] dark:text-[#fbbf24]">
                  <AlertTriangle size={13} className="shrink-0" aria-hidden />
                  {t("此令牌仅展示一次，关闭后无法再次查看")}
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-label={t("关闭")}
              onClick={() => setCreatedToken(null)}
              data-pat-banner-close=""
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            >
              <X size={15} aria-hidden />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-[#f59e0b]/35 bg-surface px-3 py-2">
            <code
              data-pat-raw-token=""
              className="min-w-0 flex-1 select-all break-all font-mono text-[12px] font-medium text-foreground"
            >
              {createdToken.rawToken}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyRaw()}
              data-pat-copy-raw=""
              className={cn(
                "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-colors",
                copiedRaw
                  ? "bg-[#00a13b] text-white"
                  : "bg-primary text-primary-foreground hover:bg-primary-hover",
              )}
            >
              {copiedRaw ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
              {copiedRaw ? t("已复制") : t("一键复制")}
            </button>
          </div>
        </section>
      )}

      {/* Section 1: Create new Personal Access Token */}
      <section className="rounded-lg border bg-surface p-4" data-pat-create-section="">
        <div className="border-b pb-3">
          <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-foreground">
            <KeyRound size={16} className="text-primary" aria-hidden />
            {t("个人访问令牌 (PAT)")}
          </h2>
          <p className="mt-0.5 text-[12px] text-subtle">
            {t("用于 CLI、自动化脚本和第三方应用以 Bearer 方式调用开放 API，请妥善保管并按最小权限分配。")}
          </p>
        </div>

        <form onSubmit={(e) => void handleCreate(e)} className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
            <label className="block text-[13px] font-medium text-foreground">
              <span>{t("令牌名称")}</span>
              <input
                type="text"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("例如：CI 自动化同步脚本")}
                data-pat-name-input=""
                className="mt-1.5 h-9 w-full rounded-md border border-[#dee0e3] bg-background px-2.5 text-[13px] font-normal text-foreground outline-none transition-colors focus:border-primary dark:border-border"
              />
            </label>

            <div className="block text-[13px] font-medium text-foreground">
              <span id="pat-expiry-label">{t("有效期")}</span>
              <div className="mt-1.5">
                <FeishuSelect
                  id="pat-expiry-select"
                  value={expiryDays}
                  options={expiryOptions}
                  onChange={setExpiryDays}
                  ariaLabel={t("有效期")}
                  menuMinWidth={160}
                  dataAttr={{ "data-pat-expiry-select": "" }}
                  className="h-9 w-full border border-[#dee0e3] bg-background px-2.5 text-[13px] font-normal dark:border-border"
                />
              </div>
            </div>
          </div>

          <div>
            <p className="text-[13px] font-medium text-foreground">{t("权限范围")}</p>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-3" role="group" aria-label={t("权限范围")}>
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors",
                  scopes.includes("read")
                    ? "border-primary/50 bg-primary/5"
                    : "border-[#dee0e3] bg-background/50 hover:bg-hover dark:border-border",
                )}
              >
                <input
                  type="checkbox"
                  checked={scopes.includes("read")}
                  onChange={() => handleToggleScope("read")}
                  data-pat-scope="read"
                  className="mt-0.5 size-4 cursor-pointer accent-[#3370ff]"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                    <span>{t("只读")}</span>
                    <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground dark:bg-white/10">
                      read
                    </code>
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-subtle">
                    {t("读取文档、表格与空间数据")}
                  </span>
                </span>
              </label>

              <label
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors",
                  scopes.includes("write")
                    ? "border-primary/50 bg-primary/5"
                    : "border-[#dee0e3] bg-background/50 hover:bg-hover dark:border-border",
                )}
              >
                <input
                  type="checkbox"
                  checked={scopes.includes("write")}
                  onChange={() => handleToggleScope("write")}
                  data-pat-scope="write"
                  className="mt-0.5 size-4 cursor-pointer accent-[#3370ff]"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                    <span>{t("读写")}</span>
                    <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground dark:bg-white/10">
                      write
                    </code>
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-subtle">
                    {t("创建与编辑文档、记录和评论")}
                  </span>
                </span>
              </label>

              <label
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors",
                  scopes.includes("admin")
                    ? "border-primary/50 bg-primary/5"
                    : "border-[#dee0e3] bg-background/50 hover:bg-hover dark:border-border",
                )}
              >
                <input
                  type="checkbox"
                  checked={scopes.includes("admin")}
                  onChange={() => handleToggleScope("admin")}
                  data-pat-scope="admin"
                  className="mt-0.5 size-4 cursor-pointer accent-[#3370ff]"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                    <span>{t("管理")}</span>
                    <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground dark:bg-white/10">
                      admin
                    </code>
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-subtle">
                    {t("管理组织、安全策略与 Webhook")}
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="text-[12px] text-subtle">
              {t("每个账号最多保留 50 个生效中的访问令牌")}
            </span>
            <button
              type="submit"
              disabled={creating || !name.trim() || scopes.length === 0 || activeCount >= PAT_MAX_ACTIVE}
              data-pat-create-submit=""
              className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Plus size={14} aria-hidden />
              {creating ? t("生成中…") : t("生成访问令牌")}
            </button>
          </div>
        </form>
      </section>

      {/* Section 2: Existing PATs list */}
      <section className="rounded-lg border bg-surface p-4" data-pat-list-section="">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-[14px] font-semibold text-foreground">{t("已创建的访问令牌")}</h3>
            <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {t("{count} / 50 生效中", { count: activeCount })}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void tokensQuery.refetch()}
            disabled={tokensQuery.isFetching}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2.5 text-[12px] text-foreground transition-colors hover:bg-hover disabled:opacity-50"
          >
            <RefreshCw size={12} className={tokensQuery.isFetching ? "animate-spin" : ""} aria-hidden />
            {t("刷新")}
          </button>
        </div>

        {tokensQuery.isError ? (
          <div className="py-8 text-center text-[13px] text-destructive" role="alert">
            {t("无法加载个人访问令牌列表，请稍后重试。")}
          </div>
        ) : tokensQuery.isPending ? (
          <div className="py-8 text-center text-[13px] text-subtle">{t("加载中…")}</div>
        ) : tokens.length === 0 ? (
          <div className="py-8 text-center" data-pat-empty="">
            <KeyRound size={24} className="mx-auto text-subtle/60" aria-hidden />
            <p className="mt-2 text-[13px] text-muted-foreground">{t("尚未创建任何个人访问令牌")}</p>
            <p className="mt-0.5 text-[12px] text-subtle">
              {t("在上方填写名称与权限范围即可快速生成用于 API 调用的令牌。")}
            </p>
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-left text-[13px]" data-pat-table="">
              <thead>
                <tr className="border-b text-[12px] font-medium text-subtle">
                  <th className="py-2 pr-3 font-medium">{t("名称 / 令牌前缀")}</th>
                  <th className="px-3 py-2 font-medium">{t("权限范围")}</th>
                  <th className="px-3 py-2 font-medium">{t("最近使用")}</th>
                  <th className="px-3 py-2 font-medium">{t("状态与有效期")}</th>
                  <th className="py-2 pl-3 text-right font-medium">{t("操作")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {tokens.map((tok) => {
                  const status = getPATStatus(tok);
                  const isRevoked = status === "revoked";
                  const statusLabel =
                    status === "revoked"
                      ? t("已吊销")
                      : status === "expired"
                        ? t("已过期")
                        : t("生效中");

                  return (
                    <tr
                      key={tok.id}
                      data-pat-row={String(tok.id)}
                      data-pat-status={status}
                      className={cn(
                        "transition-colors hover:bg-hover/40",
                        isRevoked && "opacity-65",
                      )}
                    >
                      <td className="py-2.5 pr-3 align-middle">
                        <div className="font-medium text-foreground">{tok.name}</div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                            {`${tok.tokenPrefix}...`}
                          </code>
                          <span className="text-[11px] text-subtle">
                            {t("创建于 {date}", { date: formatPATDate(tok.createdAt) })}
                          </span>
                        </div>
                      </td>

                      <td className="px-3 py-2.5 align-middle">
                        <div className="flex flex-wrap gap-1">
                          {tok.scopes.map((sc) => (
                            <span
                              key={sc}
                              className={cn(
                                "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium",
                                scopePillTone(sc),
                              )}
                            >
                              {sc}
                            </span>
                          ))}
                        </div>
                      </td>

                      <td className="px-3 py-2.5 align-middle text-[12px] text-muted-foreground">
                        {tok.lastUsedAt ? (
                          <span className="inline-flex items-center gap-1">
                            <Clock size={12} className="shrink-0 text-subtle" aria-hidden />
                            {formatPATDateTime(tok.lastUsedAt)}
                          </span>
                        ) : (
                          <span className="text-subtle">{t("从未使用")}</span>
                        )}
                      </td>

                      <td className="px-3 py-2.5 align-middle">
                        <div className="flex flex-col items-start gap-1">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                              statusPillTone(status),
                            )}
                          >
                            {statusLabel}
                          </span>
                          <span className="text-[11px] text-subtle">
                            {isRevoked && tok.revokedAt
                              ? t("吊销于 {date}", { date: formatPATDate(tok.revokedAt) })
                              : tok.expiresAt
                                ? t("到期：{date}", { date: formatPATDate(tok.expiresAt) })
                                : t("永不过期")}
                          </span>
                        </div>
                      </td>

                      <td className="py-2.5 pl-3 text-right align-middle">
                        {isRevoked ? (
                          <span className="text-[12px] text-subtle">{t("已吊销")}</span>
                        ) : (
                          <button
                            type="button"
                            disabled={revokingId === tok.id}
                            onClick={() => void handleRevoke(tok)}
                            data-pat-revoke={String(tok.id)}
                            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-destructive/30 px-2.5 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            <Trash2 size={12} aria-hidden />
                            {revokingId === tok.id ? t("吊销中…") : t("吊销")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 3: Concise curl example box */}
      <section className="rounded-lg border bg-surface p-4" data-pat-curl-example="">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
            <Terminal size={14} className="text-primary" aria-hidden />
            {t("API 调用示例")}
          </h3>
          <button
            type="button"
            onClick={() => void handleCopyCurl()}
            data-pat-copy-curl=""
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            {copiedCurl ? <Check size={12} className="text-[#00a13b]" aria-hidden /> : <Copy size={12} aria-hidden />}
            {copiedCurl ? t("已复制") : t("复制命令")}
          </button>
        </div>
        <p className="mt-1 text-[12px] text-subtle">
          {t("在 HTTP 请求头中附加 Authorization Bearer 令牌即可完成身份认证：")}
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md border bg-[#f7f8fa] px-3 py-2.5 font-mono text-[12px] leading-5 text-foreground dark:bg-[#1e2024]">
          <code>{curlSnippet}</code>
        </pre>
      </section>
    </div>
  );
}
