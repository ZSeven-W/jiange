import { FeishuSelect } from "@/components/feishu-select";
import { t } from "@/lib/i18n";

export type ShareLinkRole = "none" | "anon" | "view" | "edit" | "workspace_view" | "workspace_edit";
export type ShareLinkScope = "restricted" | "workspace" | "signed-in" | "public";

export function shareLinkScope(role: ShareLinkRole): ShareLinkScope {
  return role === "none" ? "restricted" : role === "anon" ? "public" : role === "workspace_view" || role === "workspace_edit" ? "workspace" : "signed-in";
}

/** Changing scope must never accidentally grant edit access. */
export function roleForScope(scope: ShareLinkScope, current: ShareLinkRole): ShareLinkRole {
  if (scope === "restricted") return "none";
  if (scope === "public") return "anon";
  if (scope === "workspace") return current === "workspace_edit" ? "workspace_edit" : "workspace_view";
  return current === "edit" ? "edit" : "view";
}

export function ShareLinkScopeSelect({ role, allowPublic, disabled, onChange }: { role: ShareLinkRole; allowPublic: boolean; disabled: boolean; onChange: (role: ShareLinkRole) => void }) {
  const scope = shareLinkScope(role);
  const options = [
    { value: "restricted", label: t("仅限已有权限的人") },
    { value: "workspace", label: t("当前空间成员") },
    { value: "signed-in", label: t("已登录用户") },
    ...((allowPublic || scope === "public") ? [{ value: "public", label: t("互联网上任何人"), disabled: !allowPublic }] : []),
  ];
  return (
    <FeishuSelect
      ariaLabel={t("链接分享范围")}
      value={scope}
      disabled={disabled}
      options={options}
      onChange={(val) => onChange(roleForScope(val as ShareLinkScope, role))}
      className="h-7 max-w-full bg-transparent px-1 text-[14px] font-medium text-foreground hover:bg-hover disabled:opacity-60"
      chevronSize={12}
      menuMinWidth={168}
    />
  );
}

export function ShareLinkAccessSelect({ role, disabled, onChange }: { role: ShareLinkRole; disabled: boolean; onChange: (role: ShareLinkRole) => void }) {
  if (role === "none") return <span className="shrink-0 text-[13px] text-muted-foreground">{t("按协作者权限")}</span>;
  if (role === "anon") return <span className="shrink-0 px-2 text-[13px] text-muted-foreground">{t("可阅读")}</span>;
  const accessValue = role === "workspace_edit" ? "edit" : role === "workspace_view" ? "view" : role;
  return (
    <FeishuSelect
      ariaLabel={t("链接分享权限")}
      value={accessValue}
      disabled={disabled}
      options={[
        { value: "view", label: t("可阅读") },
        { value: "edit", label: t("可编辑") },
      ]}
      onChange={(val) => {
        const next = val as "view" | "edit";
        onChange(shareLinkScope(role) === "workspace" ? (next === "edit" ? "workspace_edit" : "workspace_view") : next);
      }}
      className="h-8 bg-transparent px-2 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-60"
      chevronSize={12}
      menuMinWidth={96}
    />
  );
}
