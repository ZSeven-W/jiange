import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Clock,
  Fingerprint,
  Globe,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  MY_SESSIONS_QUERY_KEY,
  changePassword,
  listMySessions,
  revokeMySession,
  revokeOtherSessions,
  type UserSession,
} from "@/lib/account-security-api";
import { MFA_STATUS_QUERY_KEY, mfaApi, type MfaStatus } from "@/lib/mfa-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MfaSettings } from "./mfa-settings";
import { PasskeySettings } from "./passkey-settings";
import { PatManager } from "./pat-manager";
import { useI18n, type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const OPEN_EVENT = "jiange:open-account-security";

export type AccountSecurityTab = "mfa" | "passkey" | "pat" | "password" | "sessions";

interface ExtendedMfaStatus extends MfaStatus {
  mfaRequiredByPolicy?: boolean;
  mfaRequiredWorkspaces?: string[];
  mfaSetupRequired?: boolean;
}

export function openAccountSecurity(tab: AccountSecurityTab = "mfa") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AccountSecurityTab>(OPEN_EVENT, { detail: tab }));
}

function formatSessionDateTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseUserAgentSummary(
  ua: string,
  t: TFunc,
): { label: string; isMobile: boolean } {
  const raw = ua.trim();
  if (!raw) {
    return { label: t("未知设备"), isMobile: false };
  }
  const lower = raw.toLowerCase();
  const isMobile =
    lower.includes("iphone") ||
    lower.includes("ipad") ||
    lower.includes("android") ||
    lower.includes("mobile");

  let os = "";
  if (lower.includes("iphone")) os = "iPhone";
  else if (lower.includes("ipad")) os = "iPad";
  else if (lower.includes("android")) os = "Android";
  else if (lower.includes("mac os x") || lower.includes("macintosh")) os = "macOS";
  else if (lower.includes("windows")) os = "Windows";
  else if (lower.includes("linux")) os = "Linux";

  let browser = "";
  if (lower.includes("edg/") || lower.includes("edge/")) browser = "Edge";
  else if (lower.includes("opr/") || lower.includes("opera")) browser = "Opera";
  else if (lower.includes("firefox/")) browser = "Firefox";
  else if (lower.includes("chrome/") || lower.includes("crios/")) browser = "Chrome";
  else if (lower.includes("safari/")) browser = "Safari";
  else if (lower.includes("curl/")) browser = "curl";

  if (browser && os) return { label: `${browser} · ${os}`, isMobile };
  if (browser) return { label: browser, isMobile };
  if (os) return { label: os, isMobile };
  return { label: raw.length > 48 ? `${raw.slice(0, 48)}…` : raw, isMobile };
}

function PasswordSecurityPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError("");
    setNotice("");

    if (!currentPassword) {
      setError(t("请输入当前密码"));
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 256) {
      setError(t("新密码长度需为 8–256 个字符"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("两次输入的新密码不一致"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: revokeOthers,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      void qc.invalidateQueries({ queryKey: MY_SESSIONS_QUERY_KEY });
      if (res.revokedSessions > 0) {
        setNotice(
          t("密码已修改，并已退出其他 {count} 台设备", {
            count: res.revokedSessions,
          }),
        );
      } else {
        setNotice(t("密码已修改"));
      }
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("修改密码失败，请稍后重试"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4" data-password-security-panel>
      <div className="rounded-xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Lock size={17} />
          </span>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">{t("修改登录密码")}</h3>
            <p className="mt-0.5 text-[12px] leading-5 text-subtle">
              {t("建议定期更新高强度密码，修改后可一键退出其他已登录设备以保障账号安全。")}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4" data-password-change-form>
          <div className="space-y-1.5">
            <Label htmlFor="acct-current-password" className="text-[13px] font-medium">
              {t("当前密码")}
            </Label>
            <Input
              id="acct-current-password"
              type="password"
              autoComplete="current-password"
              placeholder={t("请输入当前密码")}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              data-current-password-input
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="acct-new-password" className="text-[13px] font-medium">
              {t("新密码")}
            </Label>
            <Input
              id="acct-new-password"
              type="password"
              autoComplete="new-password"
              placeholder={t("至少 8 位字符")}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              data-new-password-input
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="acct-confirm-password" className="text-[13px] font-medium">
              {t("确认新密码")}
            </Label>
            <Input
              id="acct-confirm-password"
              type="password"
              autoComplete="new-password"
              placeholder={t("再次输入新密码")}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              data-confirm-password-input
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border/80 bg-canvas/70 px-3 py-2.5 text-[13px] text-foreground">
            <input
              type="checkbox"
              checked={revokeOthers}
              onChange={(e) => setRevokeOthers(e.target.checked)}
              className="size-4 accent-primary"
              data-revoke-others-checkbox
            />
            <span>{t("同时退出其他设备登录")}</span>
          </label>

          {error && (
            <div
              role="alert"
              data-password-change-error
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[13px] text-destructive"
            >
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {notice && (
            <div
              role="status"
              data-password-change-notice
              className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-[13px] text-emerald-700 dark:text-emerald-300"
            >
              <Check size={15} className="mt-0.5 shrink-0" />
              <span>{notice}</span>
            </div>
          )}

          <div className="flex justify-end pt-1">
            <Button type="submit" disabled={submitting} data-password-change-submit>
              {submitting ? t("保存中…") : t("保存新密码")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ActiveSessionsPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [confirmRevokeId, setConfirmRevokeId] = useState<number | null>(null);
  const [confirmRevokeOthers, setConfirmRevokeOthers] = useState(false);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const sessionsQuery = useQuery<UserSession[]>({
    queryKey: MY_SESSIONS_QUERY_KEY,
    queryFn: ({ signal }) => listMySessions(signal),
    retry: false,
  });

  const sessions = sessionsQuery.data ?? [];
  const otherSessionsCount = sessions.filter((s) => !s.current).length;

  const handleRevokeOne = async (sessionId: number) => {
    if (revokingId !== null || revokingOthers) return;
    setRevokingId(sessionId);
    setError("");
    setNotice("");
    try {
      await revokeMySession(sessionId);
      setConfirmRevokeId(null);
      await qc.invalidateQueries({ queryKey: MY_SESSIONS_QUERY_KEY });
      setNotice(t("已将该设备强制下线"));
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("下线设备失败，请稍后重试"),
      );
    } finally {
      setRevokingId(null);
    }
  };

  const handleRevokeOthers = async () => {
    if (revokingOthers || revokingId !== null) return;
    setRevokingOthers(true);
    setError("");
    setNotice("");
    try {
      const res = await revokeOtherSessions();
      setConfirmRevokeOthers(false);
      await qc.invalidateQueries({ queryKey: MY_SESSIONS_QUERY_KEY });
      setNotice(
        res.revoked > 0
          ? t("已退出其他 {count} 台设备", { count: res.revoked })
          : t("没有其他在线设备"),
      );
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("退出其他设备失败，请稍后重试"),
      );
    } finally {
      setRevokingOthers(false);
    }
  };

  return (
    <div className="space-y-4" data-sessions-security-panel>
      <div className="rounded-xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <MonitorSmartphone size={17} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[14px] font-semibold text-foreground">{t("已登录设备与会话")}</h3>
                <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {t("共 {count} 台活跃设备", { count: sessions.length })}
                </span>
              </div>
              <p className="mt-0.5 text-[12px] leading-5 text-subtle">
                {t("查看当前账号的所有活跃登录会话，如发现异常设备可立即将其远程下线。")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void sessionsQuery.refetch()}
              disabled={sessionsQuery.isFetching}
              data-sessions-refresh-btn
            >
              <RefreshCw size={13} className={cn("mr-1.5", sessionsQuery.isFetching && "animate-spin")} />
              {t("刷新")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={otherSessionsCount === 0 || revokingOthers}
              onClick={() => {
                setConfirmRevokeId(null);
                setConfirmRevokeOthers(true);
              }}
              className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
              data-revoke-other-sessions-btn
            >
              <LogOut size={13} className="mr-1.5" />
              {t("退出其他所有设备")}
            </Button>
          </div>
        </div>

        {confirmRevokeOthers && (
          <div
            data-revoke-others-confirm
            className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-[13px]"
          >
            <span className="text-foreground">
              {t("确认退出其他 {count} 台已登录设备？这些设备将需要重新登录。", {
                count: otherSessionsCount,
              })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmRevokeOthers(false)}
                disabled={revokingOthers}
              >
                {t("取消")}
              </Button>
              <Button
                type="button"
                size="sm"
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => void handleRevokeOthers()}
                disabled={revokingOthers}
                data-revoke-others-confirm-btn
              >
                {revokingOthers ? t("处理中…") : t("确认退出")}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[13px] text-destructive"
          >
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {notice && (
          <div
            role="status"
            className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-[13px] text-emerald-700 dark:text-emerald-300"
          >
            <Check size={15} className="mt-0.5 shrink-0" />
            <span>{notice}</span>
          </div>
        )}

        <div className="mt-4 space-y-2.5">
          {sessionsQuery.isLoading ? (
            <div className="rounded-lg border border-dashed border-border py-8 text-center text-[13px] text-subtle">
              {t("正在加载登录设备…")}
            </div>
          ) : sessionsQuery.isError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-4 text-[13px] text-destructive">
              {sessionsQuery.error instanceof Error
                ? sessionsQuery.error.message
                : t("加载登录设备失败")}
            </div>
          ) : sessions.length === 0 ? (
            <div
              data-sessions-empty
              className="rounded-lg border border-dashed border-border py-8 text-center text-[13px] text-subtle"
            >
              {t("暂无活跃登录会话")}
            </div>
          ) : (
            sessions.map((session) => {
              const summary = parseUserAgentSummary(session.userAgent, t);
              const isConfirming = confirmRevokeId === session.id;
              return (
                <div
                  key={session.id}
                  data-session-item={session.id}
                  className="rounded-lg border border-border bg-canvas/50 px-3.5 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-muted-foreground ring-1 ring-border">
                        {summary.isMobile ? <Smartphone size={15} /> : <Laptop size={15} />}
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-foreground">
                            {summary.label}
                          </span>
                          {session.current && (
                            <span
                              data-current-session-badge
                              className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
                            >
                              {t("当前设备")}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-subtle">
                          <span className="inline-flex items-center gap-1">
                            <Globe size={12} />
                            {session.ipAddress || t("未知 IP")}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock size={12} />
                            {t("登录于 {time}", { time: formatSessionDateTime(session.createdAt) })}
                          </span>
                          <span>
                            {t("最近活跃：{time}", { time: formatSessionDateTime(session.lastSeenAt) })}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="shrink-0">
                      {session.current ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled
                          title={t("当前正在使用的设备")}
                          data-session-revoke-btn={session.id}
                        >
                          {t("下线")}
                        </Button>
                      ) : isConfirming ? (
                        <div className="flex items-center gap-1.5" data-session-confirm-box={session.id}>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirmRevokeId(null)}
                            disabled={revokingId === session.id}
                          >
                            {t("取消")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="bg-destructive text-white hover:bg-destructive/90"
                            onClick={() => void handleRevokeOne(session.id)}
                            disabled={revokingId === session.id}
                            data-session-confirm-revoke={session.id}
                          >
                            {revokingId === session.id ? t("处理中…") : t("确认下线")}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setConfirmRevokeOthers(false);
                            setConfirmRevokeId(session.id);
                          }}
                          disabled={revokingId !== null || revokingOthers}
                          data-session-revoke-btn={session.id}
                        >
                          {t("下线")}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export interface AccountSecurityHostProps {
  initialOpen?: boolean;
  initialTab?: AccountSecurityTab;
}

export function AccountSecurityHost({
  initialOpen = false,
  initialTab = "mfa",
}: AccountSecurityHostProps = {}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(initialOpen);
  const [tab, setTab] = useState<AccountSecurityTab>(initialTab);

  const mfaStatusQuery = useQuery<ExtendedMfaStatus>({
    queryKey: MFA_STATUS_QUERY_KEY,
    queryFn: () => mfaApi.getStatus() as Promise<ExtendedMfaStatus>,
    enabled: open,
    retry: false,
  });

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<AccountSecurityTab | undefined>).detail;
      if (
        detail === "mfa" ||
        detail === "passkey" ||
        detail === "pat" ||
        detail === "password" ||
        detail === "sessions"
      ) {
        setTab(detail);
      }
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const mfaSetupRequired = Boolean(mfaStatusQuery.data?.mfaSetupRequired);
  const requiredWorkspaces = mfaStatusQuery.data?.mfaRequiredWorkspaces ?? [];

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-3 sm:p-6"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("账号安全与访问令牌")}
        data-account-security-dialog
        className="flex max-h-[90dvh] w-full max-w-[780px] flex-col overflow-hidden rounded-xl border border-[#dee0e3] bg-surface shadow-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
              <ShieldCheck size={17} />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold text-foreground">{t("账号安全与访问令牌")}</h2>
              <p className="text-[12px] text-subtle">
                {t("管理二步验证（TOTP MFA）、通行密钥（Passkey）、密码、登录设备与个人访问令牌（PAT）")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t("关闭")}
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex items-center gap-1 overflow-x-auto border-b bg-surface px-5">
          <button
            type="button"
            data-security-tab="mfa"
            aria-selected={tab === "mfa"}
            onClick={() => setTab("mfa")}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
              tab === "mfa"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <ShieldCheck size={14} />
            {t("二步验证（MFA）")}
          </button>
          <button
            type="button"
            data-security-tab="passkey"
            aria-selected={tab === "passkey"}
            onClick={() => setTab("passkey")}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
              tab === "passkey"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Fingerprint size={14} />
            {t("通行密钥 / Passkey")}
          </button>
          <button
            type="button"
            data-security-tab="password"
            aria-selected={tab === "password"}
            onClick={() => setTab("password")}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
              tab === "password"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Lock size={14} />
            {t("修改密码")}
          </button>
          <button
            type="button"
            data-security-tab="sessions"
            aria-selected={tab === "sessions"}
            onClick={() => setTab("sessions")}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
              tab === "sessions"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <MonitorSmartphone size={14} />
            {t("登录设备")}
          </button>
          <button
            type="button"
            data-security-tab="pat"
            aria-selected={tab === "pat"}
            onClick={() => setTab("pat")}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
              tab === "pat"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <KeyRound size={14} />
            {t("个人访问令牌 (PAT)")}
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto bg-canvas p-4 sm:p-5">
          {mfaSetupRequired && (
            <div
              role="alert"
              data-mfa-policy-required-banner
              className="flex items-start gap-2.5 rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-800 dark:text-amber-200"
            >
              <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0">
                <p className="font-semibold">{t("工作空间要求开启二步验证")}</p>
                <p className="mt-0.5 text-[12px] leading-5 opacity-90">
                  {requiredWorkspaces.length > 0
                    ? t("所在工作空间（{workspaces}）已强制要求开启二步验证，请尽快配置 TOTP 动态验证码或绑定通行密钥（Passkey）。", {
                        workspaces: requiredWorkspaces.join("、"),
                      })
                    : t("所在工作空间已强制要求开启二步验证，请尽快配置 TOTP 动态验证码或绑定通行密钥（Passkey）。")}
                </p>
              </div>
            </div>
          )}

          {tab === "mfa" ? (
            <MfaSettings />
          ) : tab === "passkey" ? (
            <PasskeySettings />
          ) : tab === "password" ? (
            <PasswordSecurityPanel />
          ) : tab === "sessions" ? (
            <ActiveSessionsPanel />
          ) : (
            <PatManager />
          )}
        </div>
      </section>
    </div>
  );
}
