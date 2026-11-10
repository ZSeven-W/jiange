import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t, useI18n } from "@/lib/i18n";
import { createPortal } from "react-dom";
import { MoreVertical } from "lucide-react";
import { ApiError, baseApi, type View } from "@/lib/api";
import { ask, askText } from "@/components/ui/ask";
import { popupPosition } from "./popupPosition";
import { useWriteLedger, type WriteLedger } from "./writeSafety";

/** Build one complete ordering for the server's atomic reorder operation. */
export function moveViewIds(ids: readonly number[], moving: number, destination: number): number[] | null {
  const from = ids.indexOf(moving), to = ids.indexOf(destination);
  if (from < 0 || to < 0 || from === to || new Set(ids).size !== ids.length) return null;
  const result = [...ids];
  result.splice(from, 1);
  result.splice(to, 0, moving);
  return result;
}

/** A rejected rename is known not to have committed; retain its text without locking all view operations. */
export function retainRejectedViewRename(ledger: WriteLedger, draft: string, viewId: number) {
  const held = ledger.begin(t("重命名视图（未保存）"), draft, undefined, undefined, false, true, { kind: "view", viewId });
  if (held !== null) ledger.fail(held, t("名称未保存，权限或视图可能已变化。请复制输入并核对后重新命名。"));
}

export function ViewTabs({ baseId, views, activeId, canEdit, dirty, icon, onSelect, onRefresh }: {
  baseId: number; views: View[]; activeId?: number; canEdit: boolean; dirty: boolean;
  icon: (type: View["type"]) => ReactNode; onSelect: (id: number) => void; onRefresh: () => Promise<unknown>;
}) {
  const [menu, setMenu] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [position, setPosition] = useState<ReturnType<typeof popupPosition> | null>(null);
  const { ledger } = useWriteLedger(baseId);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchors = useRef(new Map<number, HTMLButtonElement>());
  const pending = useRef<symbol | null>(null);
  const dragging = useRef<{ baseId: number; source: number; order: number[] } | null>(null);
  const identity = useRef({ baseId, canEdit, alive: true });
  identity.current.baseId = baseId;
  identity.current.canEdit = canEdit;
  useLayoutEffect(() => {
    identity.current.alive = true;
    return () => { identity.current.alive = false; };
  }, []);
  useEffect(() => { pending.current = null; setBusy(false); setMenu(null); setMessage(null); }, [baseId]);
  useEffect(() => { if (!canEdit) setMenu(null); }, [canEdit]);
  useEffect(() => {
    if (menu === null) return;
    const place = () => {
      const rect = anchors.current.get(menu)?.getBoundingClientRect();
      if (rect) setPosition(popupPosition(rect, window.innerWidth, window.innerHeight, 192, 240));
    };
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !anchors.current.get(menu)?.contains(e.target as Node)) setMenu(null);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(null); anchors.current.get(menu)?.focus(); } };
    place();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [menu]);

  const valid = (originalBase: number) => identity.current.alive && identity.current.baseId === originalBase && identity.current.canEdit;
  const run = async (label: string, draft: string, action: () => Promise<number | void>, preserveRejectedViewId?: number) => {
    if (pending.current || !valid(baseId)) return;
    const operation = ledger.begin(label, draft, "view:write");
    if (operation === null) return;
    const originalBase = baseId;
    const token = Symbol();
    pending.current = token;
    setBusy(true); setMessage(null); setMenu(null);
    let selectId: number | void = undefined;
    try { selectId = await action(); ledger.complete(operation); }
    catch (error) {
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (preserveRejectedViewId !== undefined && rejected) retainRejectedViewRename(ledger, draft, preserveRejectedViewId);
      if (rejected) ledger.complete(operation);
      else ledger.fail(operation, t("无法确认视图操作是否完成，请检查视图列表后再操作。"));
      if (valid(originalBase)) setMessage(error instanceof ApiError && error.status === 409 ? t("视图已发生变化，请检查后重试。") : t("无法确认视图操作是否完成，请刷新后检查。 "));
    } finally {
      // An interrupted write may have committed, so always fetch the server state.
      if (identity.current.alive && identity.current.baseId === originalBase) {
        try { await onRefresh(); }
        catch { if (valid(originalBase)) setMessage(t("无法刷新视图，请稍后重试。")); }
        finally {
          if (pending.current === token) {
            pending.current = null;
            if (selectId !== undefined && valid(originalBase)) onSelect(selectId);
            setBusy(false);
          }
        }
      }
    }
  };
  const rename = async (view: View) => {
    const originalBase = baseId;
    setMenu(null);
    const name = await askText(t("重命名视图"), t("视图名称"), view.name);
    if (name === null || !valid(originalBase)) return;
    const trimmed = name.trim();
    if (!trimmed || [...trimmed].length > 100) { setMessage(t("视图名称需为 1–100 个字符。")); return; }
    if (trimmed === view.name) return;
    void run(t("重命名视图"), trimmed, async () => { await baseApi.renameView(originalBase, view.id, view.name, trimmed); }, view.id);
  };
  const duplicate = async (view: View) => {
    const originalBase = baseId;
    setMenu(null);
    if (dirty && view.id === activeId && !await ask(t("复制已保存的视图？"), t("当前临时配置尚未保存，副本将使用已保存的配置。"), false)) return;
    if (!valid(originalBase)) return;
    void run(t("复制视图"), view.name, async () => (await baseApi.duplicateView(originalBase, view.id)).id);
  };
  const remove = async (view: View) => {
    const originalBase = baseId;
    setMenu(null);
    if (!await ask(t("删除视图「{name}」？", { name: view.name }), t("删除后不可恢复。")) || !valid(originalBase)) return;
    void run(t("删除视图"), view.name, async () => { await baseApi.deleteView(originalBase, view.id); });
  };
  const reorder = (view: View, destination: View, expected = views.map((item) => item.id)) => {
    const order = moveViewIds(expected, view.id, destination.id);
    if (order) void run(t("调整视图顺序"), "", async () => { await baseApi.reorderViews(baseId, expected, order); });
  };
  const selected = views.find((view) => view.id === menu);
  const selectedIndex = selected ? views.findIndex((view) => view.id === selected.id) : -1;
  return <>
    <div className="flex min-w-0 shrink items-center overflow-x-auto" role="tablist" aria-label={t("视图")}>
      {views.map((view) => <div key={view.id} className={`group/view flex h-10 shrink-0 items-center rounded-t-md ${view.id === activeId ? "bg-surface font-medium text-foreground shadow-[0_-1px_4px_rgba(31,35,41,0.05)]" : "text-muted-foreground hover:bg-hover hover:text-foreground"}`}
        draggable={canEdit && !busy && !ledger.blocked("view:write")}
        onDragStart={(event) => { dragging.current = { baseId, source: view.id, order: views.map((item) => item.id) }; event.dataTransfer.setData("application/x-jiange-view", String(view.id)); event.dataTransfer.effectAllowed = "move"; }}
        onDragEnd={() => { dragging.current = null; }}
        onDragOver={(event) => { if (canEdit && event.dataTransfer.types.includes("application/x-jiange-view")) event.preventDefault(); }}
        onDrop={(event) => { event.preventDefault(); const drag = dragging.current; dragging.current = null; const source = views.find((item) => item.id === drag?.source); if (drag && drag.baseId === baseId && source && canEdit) reorder(source, view, drag.order); }}>
        <button type="button" role="tab" aria-selected={view.id === activeId} data-view-tab={view.type} className="flex h-full items-center gap-1.5 pl-3 pr-1" onClick={() => onSelect(view.id)}>{icon(view.type)}<span>{view.name}</span></button>
        {canEdit && <button type="button" ref={(el) => { if (el) anchors.current.set(view.id, el); else anchors.current.delete(view.id); }} aria-label={t("{name}视图菜单", { name: view.name })} aria-expanded={menu === view.id} disabled={busy || ledger.blocked("view:write")} onClick={() => setMenu(menu === view.id ? null : view.id)} className={`mr-1 grid size-6 place-items-center rounded hover:bg-hover disabled:opacity-50 ${view.id === activeId ? "text-muted-foreground" : "text-subtle sm:opacity-0 sm:group-hover/view:opacity-100"}`}><MoreVertical size={16} /></button>}
      </div>)}
    </div>
    {selected && position && createPortal(<div ref={menuRef} style={position} role="menu" className="fixed z-[100] rounded-lg border bg-surface p-1 text-[13px] shadow-lg">
      <button type="button" role="menuitem" className="block w-full rounded px-3 py-2 text-left hover:bg-hover" onClick={() => void rename(selected)}>{t("重命名")}</button>
      <button type="button" role="menuitem" className="block w-full rounded px-3 py-2 text-left hover:bg-hover" onClick={() => void duplicate(selected)}>{t("复制视图")}</button>
      {selectedIndex > 0 && <button type="button" role="menuitem" className="block w-full rounded px-3 py-2 text-left hover:bg-hover" onClick={() => reorder(selected, views[selectedIndex - 1])}>{t("向左移动")}</button>}
      {selectedIndex >= 0 && selectedIndex < views.length - 1 && <button type="button" role="menuitem" className="block w-full rounded px-3 py-2 text-left hover:bg-hover" onClick={() => reorder(selected, views[selectedIndex + 1])}>{t("向右移动")}</button>}
      <button type="button" role="menuitem" disabled={views.length <= 1} className="block w-full rounded px-3 py-2 text-left text-destructive hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40" onClick={() => void remove(selected)}>{t("删除视图")}</button>
    </div>, document.body)}
    {message && <span role="alert" title={message} className="max-w-28 shrink truncate text-xs text-destructive">{message}</span>}
  </>;
}
