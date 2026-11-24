import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Fingerprint, KeyRound, ShieldCheck, X } from "lucide-react";
import { MFA_STATUS_QUERY_KEY, mfaApi, type MfaStatus } from "@/lib/mfa-api";
import { MfaSettings } from "./mfa-settings";
import { PasskeySettings } from "./passkey-settings";
import { PatManager } from "./pat-manager";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const OPEN_EVENT = "jiange:open-account-security";

export type AccountSecurityTab = "mfa" | "passkey" | "pat";

interface ExtendedMfaStatus extends MfaStatus {
  mfaRequiredByPolicy?: boolean;
  mfaRequiredWorkspaces?: string[];
  mfaSetupRequired?: boolean;
}

export function openAccountSecurity(tab: AccountSecurityTab = "mfa") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AccountSecurityTab>(OPEN_EVENT, { detail: tab }));
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
      if (detail === "mfa" || detail === "passkey" || detail === "pat") setTab(detail);
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
                {t("管理二步验证（TOTP MFA）、通行密钥（Passkey）与个人访问令牌（PAT）")}
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

        <div className="flex items-center gap-1 border-b bg-surface px-5">
          <button
            type="button"
            data-security-tab="mfa"
            aria-selected={tab === "mfa"}
            onClick={() => setTab("mfa")}
            className={cn(
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
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
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
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
            data-security-tab="pat"
            aria-selected={tab === "pat"}
            onClick={() => setTab("pat")}
            className={cn(
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
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
          ) : (
            <PatManager />
          )}
        </div>
      </section>
    </div>
  );
}
