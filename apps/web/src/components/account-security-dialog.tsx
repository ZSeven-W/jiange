import { useEffect, useState } from "react";
import { KeyRound, ShieldCheck, X } from "lucide-react";
import { MfaSettings } from "./mfa-settings";
import { PatManager } from "./pat-manager";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const OPEN_EVENT = "jiange:open-account-security";

export type AccountSecurityTab = "mfa" | "pat";

export function openAccountSecurity(tab: AccountSecurityTab = "mfa") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AccountSecurityTab>(OPEN_EVENT, { detail: tab }));
}

export function AccountSecurityHost() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<AccountSecurityTab>("mfa");

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<AccountSecurityTab | undefined>).detail;
      if (detail === "mfa" || detail === "pat") setTab(detail);
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
              <p className="text-[12px] text-subtle">{t("管理二步验证（TOTP MFA）与开放 API 个人访问令牌（PAT）")}</p>
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
              tab === "mfa" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <ShieldCheck size={14} />
            {t("二步验证（MFA）")}
          </button>
          <button
            type="button"
            data-security-tab="pat"
            aria-selected={tab === "pat"}
            onClick={() => setTab("pat")}
            className={cn(
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
              tab === "pat" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <KeyRound size={14} />
            {t("个人访问令牌 (PAT)")}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-canvas p-4 sm:p-5">
          {tab === "mfa" ? <MfaSettings /> : <PatManager />}
        </div>
      </section>
    </div>
  );
}
