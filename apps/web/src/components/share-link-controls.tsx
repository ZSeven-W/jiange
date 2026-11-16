import { ArrowDownIcon } from "@/components/feishu-icons";
import { t } from "@/lib/i18n";

export type ShareLinkRole = "none" | "anon" | "view" | "edit";
export type ShareLinkScope = "restricted" | "signed-in" | "public";

export function shareLinkScope(role: ShareLinkRole): ShareLinkScope {
  return role === "none" ? "restricted" : role === "anon" ? "public" : "signed-in";
}

/** Changing scope must never accidentally grant edit access. */
export function roleForScope(scope: ShareLinkScope, current: ShareLinkRole): ShareLinkRole {
  if (scope === "restricted") return "none";
  if (scope === "public") return "anon";
  return current === "edit" ? "edit" : "view";
}

export function ShareLinkScopeSelect({ role, allowPublic, disabled, onChange }: { role: ShareLinkRole; allowPublic: boolean; disabled: boolean; onChange: (role: ShareLinkRole) => void }) {
  const scope = shareLinkScope(role);
  const label = scope === "restricted" ? t("仅限已有权限的人") : scope === "public" ? t("互联网上任何人") : t("已登录用户");
  return <label className="relative inline-flex max-w-full items-center gap-1 rounded hover:bg-hover focus-within:ring-2 focus-within:ring-primary/40">
    <span className="sr-only">{t("链接分享范围")}</span>
    <span aria-hidden="true" className={`min-w-0 truncate text-[14px] text-foreground ${disabled ? "opacity-60" : ""}`}>{label}</span>
    <ArrowDownIcon className="pointer-events-none size-2 shrink-0 text-subtle" />
    <select aria-label={t("链接分享范围")} value={scope} disabled={disabled} onChange={(event) => onChange(roleForScope(event.target.value as ShareLinkScope, role))} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed">
      <option value="restricted">{t("仅限已有权限的人")}</option>
      <option value="signed-in">{t("已登录用户")}</option>
      {(allowPublic || scope === "public") && <option value="public" disabled={!allowPublic}>{t("互联网上任何人")}</option>}
    </select>
  </label>;
}

export function ShareLinkAccessSelect({ role, disabled, onChange }: { role: ShareLinkRole; disabled: boolean; onChange: (role: ShareLinkRole) => void }) {
  if (role === "none") return <span className="shrink-0 text-[13px] text-muted-foreground">{t("按协作者权限")}</span>;
  if (role === "anon") return <span className="shrink-0 px-2 text-[13px] text-muted-foreground">{t("可阅读")}</span>;
  return <label className="relative inline-flex shrink-0 items-center rounded hover:bg-hover">
    <span className="sr-only">{t("链接分享权限")}</span>
    <select aria-label={t("链接分享权限")} value={role} disabled={disabled} onChange={(event) => onChange(event.target.value as "view" | "edit")} className="h-8 cursor-pointer appearance-none bg-transparent pl-2 pr-5 text-[13px] text-muted-foreground outline-none disabled:cursor-not-allowed disabled:opacity-60">
      <option value="view">{t("可阅读")}</option><option value="edit">{t("可编辑")}</option>
    </select>
    <ArrowDownIcon className="pointer-events-none absolute right-1.5 size-2 text-subtle" />
  </label>;
}
