import { ApiError, type DocMeta } from "@/lib/api";
import { X } from "lucide-react";
import { HelpIcon } from "@/components/FeishuIcons";
import type { RefObject } from "react";

/** Revalidate both permission and the value the user saw before changing it. */
export async function changeCopyProtection(
  expected: boolean,
  next: boolean,
  read: () => Promise<DocMeta>,
  write: (next: boolean, expected: boolean) => Promise<unknown>,
  isCurrent: () => boolean,
): Promise<void> {
  const current = await read();
  if (!isCurrent()) throw new Error("页面状态已变化，请重新打开权限设置。");
  if (current.role !== "manage") throw new Error("你已没有管理权限，请刷新后重试。");
  if (!!current.copyProtected !== expected) throw new Error("设置已被更改，请查看最新状态后重试。");
  if (next !== expected) await write(next, expected);
}

export function copyProtectionError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409 && error.code === "share_conflict") return "设置已被更改，请查看最新状态后重试。";
  if (error instanceof TypeError) return "网络连接中断，更新结果可能尚未确认，请查看最新设置。";
  return error instanceof Error ? error.message : "更新权限设置失败，请重试。";
}

export function SharePermissions({
  protectedCopy, busy, loading, enabled, error, backRef, onBack, onChange,
}: {
  protectedCopy: boolean;
  busy: boolean;
  loading: boolean;
  enabled: boolean;
  error: string;
  backRef?: RefObject<HTMLButtonElement | null>;
  onBack: () => void;
  onChange: (next: boolean) => void;
}) {
  return <>
    <header className="flex h-[72px] shrink-0 items-center justify-between border-b px-6">
      <h2 id="share-title" className="flex items-center gap-1 text-[18px] font-semibold">权限设置 <HelpIcon className="size-[14px] text-muted-foreground" /></h2>
      <button ref={backRef} type="button" autoFocus aria-label="返回分享" aria-disabled={busy} onClick={() => { if (!busy) onBack(); }} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover aria-disabled:opacity-50"><X size={18} /></button>
    </header>
    <div className="overflow-y-auto px-6 py-6">
      <p className="mb-3 font-medium">内容安全</p>
      <label className="flex items-start justify-between gap-4 rounded-md py-2">
        <span><span className="block leading-5">防复制下载</span><span className="mt-1 block text-[12px] leading-5 text-muted-foreground">开启后限制非管理者复制、下载和导出内容</span></span>
        <input type="checkbox" aria-label="防复制下载" checked={protectedCopy} disabled={busy || !enabled} onChange={(event) => onChange(event.target.checked)} className="mt-1 size-4 accent-primary disabled:opacity-50" />
      </label>
      {loading && <p role="status" className="pt-2 text-[12px] text-muted-foreground">正在验证权限设置…</p>}
      {error && <p role="alert" className="pt-2 text-[12px] text-destructive">{error}</p>}
    </div>
  </>;
}
