import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Folder, Search, X } from "lucide-react";
import { api, docsApi, driveApi, extrasApi, type DocMeta, type DriveEntry } from "@/lib/api";
import { t, useI18n } from "@/lib/i18n";
import { docMetaKey } from "./docMetaState";

type MoveSource = { meta: DocMeta; personal: boolean };

/** Discover the source scope only from a visible, complete ancestor chain. */
export function resolveMoveSource(meta: DocMeta, ancestors: DocMeta[], personal: DriveEntry[], shared: DriveEntry[]): MoveSource | null {
  if (meta.kind !== "doc" || meta.role !== "manage" || !Number.isSafeInteger(meta.id) || meta.id <= 0 || !Number.isSafeInteger(meta.workspaceId) || meta.workspaceId <= 0 || !Number.isSafeInteger(meta.driveRevision ?? 0) || (meta.driveRevision ?? 0) < 0) return null;
  if (meta.parentId !== null && (ancestors.length === 0 || ancestors.at(-1)?.id !== meta.parentId)) return null;
  if (meta.parentId === null && ancestors.length !== 0) return null;
  const seen = new Set([meta.id]);
  for (let index = 0; index < ancestors.length; index++) {
    const item = ancestors[index];
    if (!Number.isSafeInteger(item.id) || item.id <= 0 || seen.has(item.id) || item.workspaceId !== meta.workspaceId || item.parentId !== (index === 0 ? null : ancestors[index - 1].id)) return null;
    seen.add(item.id);
  }
  const rootId = ancestors[0]?.id ?? meta.id;
  const roots = [...personal.map((entry) => ({ entry, personal: true })), ...shared.map((entry) => ({ entry, personal: false }))].filter(({ entry }) => entry.id === rootId && entry.workspaceId === meta.workspaceId && entry.parentId === null);
  return roots.length === 1 ? { meta, personal: roots[0].personal } : null;
}

async function checkAccount(userId: number) {
  const me = await api.me();
  if (me.user.id !== userId) throw new Error(t("登录账号已变化，请重新打开移动窗口。"));
}

export function DocumentMoveDialog({ docId, userId, onClose, onMoved }: { docId: number; userId: number; onClose: () => void; onMoved: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [path, setPath] = useState<DriveEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const pendingRef = useRef(false), alive = useRef(true);
  const panel = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const source = useQuery({ queryKey: ["document-move-source", userId, docId], gcTime: 0, retry: false, refetchOnMount: "always", queryFn: async () => {
    await checkAccount(userId);
    const meta = await docsApi.get(docId);
    const [ancestors, personal, shared] = await Promise.all([extrasApi.ancestors(docId), driveApi.children(null, true, meta.workspaceId), driveApi.children(null, false, meta.workspaceId)]);
    await checkAccount(userId);
    const result = resolveMoveSource(meta, ancestors, personal, shared);
    if (!result) throw new Error(t("无法确认文档所在空间或移动权限，请刷新后重试。"));
    return result;
  } });
  const parent = path.at(-1)?.id ?? null;
  const folders = useQuery({ queryKey: ["document-move-folders", userId, docId, source.data?.meta.workspaceId, source.data?.personal, parent], enabled: !!source.data && !source.isFetching && !source.isError, gcTime: 0, retry: false, queryFn: async () => {
    await checkAccount(userId);
    const entries = await driveApi.children(parent, source.data!.personal, source.data!.meta.workspaceId);
    await checkAccount(userId);
    return entries.filter((entry) => entry.kind === "folder" && entry.id !== docId);
  } });
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const nodes = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') ?? [])].filter((node) => node.getClientRects().length > 0);
      if (!nodes.length) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === nodes[0] || !panel.current?.contains(document.activeElement))) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
      else if (!event.shiftKey && (document.activeElement === nodes[nodes.length - 1] || !panel.current?.contains(document.activeElement))) { event.preventDefault(); nodes[0].focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { alive.current = false; document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  const destination = path.at(-1);
  const canMove = !!source.data && !source.isFetching && !source.isError && !folders.isFetching && !folders.isError && !pending && !uncertain && parent !== source.data.meta.parentId && (!destination || destination.role === "edit" || destination.role === "manage");
  const move = async () => {
    if (!source.data || !canMove || pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError("");
    try {
      await driveApi.moveForAccount(docId, parent, source.data.meta.driveRevision ?? 0, userId);
      if (alive.current) onMoved();
    } catch {
      if (alive.current) { setUncertain(true); setError(t("移动未完成或结果尚未确认，请关闭窗口并检查文档位置后再试。")); }
    } finally {
      void qc.invalidateQueries({ queryKey: docMetaKey(docId, userId) });
      void qc.invalidateQueries({ queryKey: ["ancestors", docId] });
      void qc.invalidateQueries({ queryKey: ["docs"] });
      void qc.invalidateQueries({ queryKey: ["drive"] });
      void qc.invalidateQueries({ queryKey: ["drive-nav"] });
      pendingRef.current = false; if (alive.current) setPending(false);
    }
  };
  const visible = (folders.data ?? []).filter((entry) => entry.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  return createPortal(<div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-3 sm:p-8" onMouseDown={(event) => { if (event.target === event.currentTarget && !pendingRef.current) onClose(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label={t("移动文档")} className="flex h-[min(680px,calc(100dvh-24px))] w-full max-w-[820px] flex-col rounded-lg bg-surface p-4 shadow-2xl sm:p-6">
      <header className="flex h-10 shrink-0 items-center gap-2"><h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold">{source.data ? t("从{scope}移动到", { scope: t(source.data.personal ? "我的文件夹" : "共享文件夹") }) : t("移动到")}</h2><button ref={closeButton} type="button" aria-label={t("关闭移动窗口")} disabled={pending} onClick={onClose} className="grid size-8 place-items-center rounded text-muted-foreground hover:bg-hover disabled:opacity-50"><X size={18}/></button></header>
      <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border sm:flex-row">
        <nav aria-label={t("目标空间")} className="flex shrink-0 gap-1 overflow-x-auto border-b bg-sidebar p-2 sm:w-[220px] sm:flex-col sm:border-b-0 sm:border-r">
          {[true, false].map((personal) => <button key={String(personal)} type="button" disabled={!source.data || personal !== source.data.personal} title={source.data && personal !== source.data.personal ? t("暂不支持跨空间移动") : undefined} onClick={() => { setPath([]); setFilter(""); }} className={`h-10 shrink-0 rounded-md px-3 text-left text-[13px] ${source.data && personal === source.data.personal ? "bg-accent text-accent-foreground" : "text-subtle opacity-60"}`}>{t(personal ? "我的文件夹" : "共享文件夹")}</button>)}
          <p className="hidden px-3 pt-3 text-[12px] leading-5 text-subtle sm:block">{t("当前仅支持同一空间内移动到文件夹。")}</p>
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col p-3"><label className="flex h-9 items-center gap-2 rounded-md border px-3 text-subtle"><Search size={15}/><span className="sr-only">{t("筛选当前文件夹")}</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("筛选当前文件夹")} className="min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none sm:text-[13px]"/></label>
          <div className="mt-3 flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground">{source.data && <button type="button" onClick={() => { setPath([]); setFilter(""); }} className="rounded px-1 py-1 hover:bg-hover">{t(source.data.personal ? "我的文件夹" : "共享文件夹")}</button>}{path.map((folder, index) => <span key={folder.id} className="flex items-center gap-1"><ChevronRight size={13}/><button type="button" onClick={() => { setPath(path.slice(0, index + 1)); setFilter(""); }} className="max-w-32 truncate rounded px-1 py-1 hover:bg-hover">{folder.title}</button></span>)}</div>
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto">{(source.isPending || folders.isFetching) && <p role="status" className="px-2 py-4 text-[13px] text-subtle">{t("正在加载文件夹…")}</p>}{(source.isError || folders.isError) && <p role="alert" className="px-2 py-4 text-[13px] text-destructive">{source.error instanceof Error ? source.error.message : t("无法加载文件夹，请关闭后重试。")}</p>}{!source.isFetching && !folders.isFetching && !source.isError && !folders.isError && visible.length === 0 && <p className="px-2 py-4 text-[13px] text-subtle">{t(filter ? "没有匹配的文件夹" : "没有子文件夹")}</p>}{visible.map((folder) => <button key={folder.id} type="button" onClick={() => { setPath((old) => [...old, folder]); setFilter(""); }} className="flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover"><Folder size={18} fill="#ffcc4d" stroke="#f5a623"/><span className="min-w-0 flex-1 truncate">{folder.title || t("未命名文件夹")}</span><ChevronRight size={14} className="text-subtle"/></button>)}</div>
          <p className="pt-2 text-[12px] text-subtle sm:hidden">{t("当前仅支持同一空间内移动到文件夹。")}</p>
        </div>
      </div>
      {error && <p role="alert" className="pt-3 text-[13px] text-destructive">{error}</p>}
      <footer className="flex shrink-0 justify-end gap-2 pt-4"><button type="button" disabled={pending} onClick={onClose} className="rounded-md border px-4 py-2 text-[13px] hover:bg-hover disabled:opacity-50">{t("取消")}</button><button type="button" disabled={!canMove} onClick={() => void move()} className="rounded-md bg-primary px-4 py-2 text-[13px] text-white hover:bg-primary-hover disabled:opacity-50">{t(pending ? "正在移动…" : "确定")}</button></footer>
    </div>
  </div>, document.body);
}
