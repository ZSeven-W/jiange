import { t } from "@/lib/i18n";
import { ApiError, type DocMeta, type Role } from "@/lib/api";
import { X } from "lucide-react";
import { HelpIcon } from "@/components/feishu-icons";
import { FeishuSelect } from "@/components/feishu-select";
import type { RefObject } from "react";

export type ContentPermissionKey = "copyMinRole" | "downloadMinRole" | "commentMinRole";
export type ContentPermissions = { copyMinRole: Role; downloadMinRole: Role; commentMinRole?: "view" | "edit"; permissionsRevision: number };

/** Reject older servers and malformed metadata rather than presenting invented permissions. */
export function contentPermissions(meta: DocMeta | undefined): ContentPermissions | undefined {
  const isRole = (value: unknown): value is Role => value === "view" || value === "edit" || value === "manage";
  if (!meta || !isRole(meta.copyMinRole) || !isRole(meta.downloadMinRole) || !Number.isSafeInteger(meta.permissionsRevision) || meta.permissionsRevision! < 0) return undefined;
  // Older servers expose the first two settings but cannot change comment
  // policy. Keep those controls available while disabling the new one.
  if (meta.commentMinRole !== undefined && meta.commentMinRole !== "view" && meta.commentMinRole !== "edit") return undefined;
  return { copyMinRole: meta.copyMinRole, downloadMinRole: meta.downloadMinRole, ...(meta.commentMinRole !== undefined ? { commentMinRole: meta.commentMinRole } : {}), permissionsRevision: meta.permissionsRevision! };
}

/** Validate the current document, role, and revision before attempting a guarded write. */
export async function changeContentPermission(
  expected: ContentPermissions,
  key: ContentPermissionKey,
  next: Role,
  read: () => Promise<DocMeta>,
  write: (change: { copyMinRole?: Role; downloadMinRole?: Role; commentMinRole?: "view" | "edit" }, expectedRevision: number) => Promise<unknown>,
  isCurrent: () => boolean,
): Promise<void> {
  const current = await read();
  if (!isCurrent()) throw new Error(t("页面状态已变化，请重新打开权限设置。"));
  if (current.role !== "manage") throw new Error(t("你已没有管理权限，请刷新后重试。"));
  const verified = contentPermissions(current);
  if (!verified) throw new Error(t("当前服务不支持分项权限设置，请刷新后重试。"));
  if (verified.permissionsRevision !== expected.permissionsRevision || verified.copyMinRole !== expected.copyMinRole || verified.downloadMinRole !== expected.downloadMinRole || verified.commentMinRole !== expected.commentMinRole) {
    throw new Error(t("设置已被更改，请查看最新状态后重试。"));
  }
  if (key === "commentMinRole" && (expected.commentMinRole === undefined || (next !== "view" && next !== "edit"))) throw new Error(t("当前服务不支持该评论权限设置。"));
  if (next !== expected[key]) await write(key === "commentMinRole" ? { commentMinRole: next as "view" | "edit" } : { [key]: next }, expected.permissionsRevision);
}

export function copyProtectionError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return t("设置已被更改，请查看最新状态后重试。");
  if (error instanceof TypeError) return t("网络连接中断，更新结果可能尚未确认，请查看最新设置。");
  return error instanceof Error ? error.message : t("更新权限设置失败，请重试。");
}

const OPTIONS: { value: Role; label: string }[] = [
  { value: "view", label: "可阅读的用户" },
  { value: "edit", label: "可编辑的用户" },
  { value: "manage", label: "可管理的用户" },
];

export function SharePermissions({
  permissions, busy, loading, enabled, error, backRef, onBack, onChange, showComment = true,
}: {
  permissions: ContentPermissions | undefined;
  busy: boolean;
  loading: boolean;
  enabled: boolean;
  error: string;
  backRef?: RefObject<HTMLButtonElement | null>;
  onBack: () => void;
  onChange: (key: ContentPermissionKey, next: Role) => void;
  /** Spreadsheets have no comments yet, so their policy has no comment row. */
  showComment?: boolean;
}) {
  return <>
    <header className="flex h-[72px] shrink-0 items-center justify-between border-b px-6">
      <h2 id="share-title" className="flex items-center gap-1 text-[18px] font-semibold">{t("权限设置")} <HelpIcon className="size-[14px] text-muted-foreground" /></h2>
      <button ref={backRef} type="button" autoFocus aria-label={t("返回分享")} aria-disabled={busy} onClick={() => { if (!busy) onBack(); }} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover aria-disabled:opacity-50"><X size={18} /></button>
    </header>
    <div className="overflow-y-auto px-6 py-6">
      {([
        ["copyMinRole", t("谁可以复制内容")],
        ["downloadMinRole", t("谁可以创建副本、打印和下载")],
        ["commentMinRole", t("谁可以评论")],
      ] as const).filter(([key]) => showComment || key !== "commentMinRole").map(([key, label]) => {
        const isUnavailable = !permissions || (key === "commentMinRole" && permissions.commentMinRole === undefined);
        const selectOptions = [
          ...(isUnavailable ? [{ value: "", label: permissions ? t("当前服务暂不支持") : t("加载中…") }] : []),
          ...OPTIONS.filter((option) => key !== "commentMinRole" || option.value !== "manage").map((option) => ({ value: option.value, label: t(option.label) })),
        ];
        return <div key={key} className="mb-7 last:mb-0">
          <label htmlFor={`permission-${key}`} className="block font-medium leading-5">{label}</label>
          <span className="mt-2 inline-flex border-b border-border">
            <FeishuSelect
              id={`permission-${key}`}
              ariaLabel={label}
              value={permissions?.[key] ?? ""}
              disabled={busy || !enabled || isUnavailable}
              options={selectOptions}
              onChange={(val) => onChange(key, val as Role)}
              className="h-9 rounded-none bg-transparent px-0 pr-1 text-[16px] hover:bg-transparent disabled:opacity-50 sm:text-[14px]"
              chevronSize={13}
              menuMinWidth={168}
            />
          </span>
        </div>;
      })}
      {loading && <p role="status" className="pt-2 text-[12px] text-muted-foreground">{t("正在验证权限设置…")}</p>}
      {error && <p role="alert" className="pt-2 text-[12px] text-destructive">{error}</p>}
    </div>
  </>;
}
