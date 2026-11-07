import { LockKeyhole } from "lucide-react";

/** Keep view controls on one touch-sized line even when the viewport is narrow. */
export function ViewConfigActions({ locked, dirty, saving, onLockedChange, onClear, onSave }: {
  locked: boolean; dirty: boolean; saving: boolean;
  onLockedChange: (locked: boolean) => void; onClear: () => void; onSave: () => void;
}) {
  return <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-3 whitespace-nowrap text-muted-foreground" data-view-config-actions>
    <label className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap hover:text-foreground" title="锁定后，协作成员只能看到此视图过滤后的行，隐藏字段对其剔除且不可写" data-lock-toggle>
      <input type="checkbox" className="shrink-0 accent-primary" checked={locked} onChange={(event) => onLockedChange(event.target.checked)} />
      <LockKeyhole size={13} className="shrink-0" /><span>权限视图</span>
    </label>
    {dirty && <><button type="button" className="h-8 shrink-0 rounded-md px-2 text-muted-foreground hover:bg-hover" onClick={onClear} data-clear-view>清除</button><button type="button" disabled={saving} className="h-8 shrink-0 rounded-md bg-primary px-2.5 font-medium text-white hover:opacity-90 disabled:opacity-50" onClick={onSave} data-save-view>{saving ? "保存中…" : "保存"}</button></>}
  </div>;
}
