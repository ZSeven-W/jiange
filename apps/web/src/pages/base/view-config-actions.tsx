import { Lock, LockKeyhole, Shield, UserRound } from "lucide-react";
import { t } from "@/lib/i18n";

/** Keep view controls on one touch-sized line even when the viewport is narrow. */
export function ViewConfigActions({
  locked,
  configLocked = false,
  isPersonal = false,
  canManage = true,
  dirty,
  saving,
  onLockedChange,
  onConfigLockedChange,
  onClear,
  onSave,
}: {
  locked: boolean;
  configLocked?: boolean;
  isPersonal?: boolean;
  canManage?: boolean;
  dirty: boolean;
  saving: boolean;
  onLockedChange: (locked: boolean) => void;
  onConfigLockedChange?: (configLocked: boolean) => void;
  onClear: () => void;
  onSave: () => void;
}) {
  const lockedForEditor = !isPersonal && configLocked && !canManage;
  return <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-3 whitespace-nowrap text-muted-foreground" data-view-config-actions>
    {isPersonal ? (
      <span className="inline-flex h-7 items-center gap-1 rounded-full bg-[#edf2ff] px-2.5 text-[12px] font-medium text-primary dark:bg-accent" title={t("个人视图仅自己可见，不影响协作者和其他视图")} data-personal-view-badge>
        <UserRound size={12} className="shrink-0" /><span>{t("个人视图")}</span>
      </span>
    ) : canManage ? (
      <>
        {onConfigLockedChange && (
          <label className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap hover:text-foreground" title={t("锁定视图配置后，仅管理员可修改筛选、排序、分组和隐藏列，协作者仍可正常读写数据")} data-config-lock-toggle>
            <input type="checkbox" className="shrink-0 accent-primary" checked={configLocked} onChange={(event) => onConfigLockedChange(event.target.checked)} />
            <Lock size={13} className="shrink-0" /><span>{t("锁定视图配置")}</span>
          </label>
        )}
        <label className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap hover:text-foreground" title={t("高级数据权限：对非管理员强制按此视图过滤行并剔除隐藏列，且限制受限角色写入")} data-lock-toggle>
          <input type="checkbox" className="shrink-0 accent-primary" checked={locked} onChange={(event) => onLockedChange(event.target.checked)} />
          <Shield size={13} className="shrink-0" /><span>{t("权限视图")}</span>
        </label>
      </>
    ) : configLocked ? (
      <span className="inline-flex h-7 items-center gap-1 rounded-full bg-amber-50 px-2.5 text-[12px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" title={t("管理员已锁定此视图配置，你仍可正常编辑数据，或新建个人视图自定义筛选排序")} data-config-locked-badge>
        <LockKeyhole size={12} className="shrink-0" /><span>{t("配置已锁定")}</span>
      </span>
    ) : null}
    {dirty && !lockedForEditor && <><button type="button" className="h-8 shrink-0 rounded-md px-2 text-muted-foreground hover:bg-hover" onClick={onClear} data-clear-view>{t("清除")}</button><button type="button" disabled={saving} className="h-8 shrink-0 rounded-md bg-primary px-2.5 font-medium text-white hover:opacity-90 disabled:opacity-50" onClick={onSave} data-save-view>{saving ? t("保存中…") : t("保存")}</button></>}
    {dirty && lockedForEditor && <button type="button" className="h-8 shrink-0 rounded-md px-2 text-muted-foreground hover:bg-hover" onClick={onClear} data-clear-view>{t("恢复默认")}</button>}
  </div>;
}
