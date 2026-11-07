import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, docsApi, type DocMeta } from "@/lib/api";
import { cn } from "@/lib/utils";
import { displayDocumentIcon } from "./DocumentGlyph";
import { Search, Shuffle, SmilePlus, Trash2 } from "lucide-react";

type IconVersion = { icon: string; revision: number };
type EmojiItem = { value: string; name: string; category: "表情" | "动物" | "食物" | "物品" | "符号" };

// These are actual Unicode characters stored by the server. The separate
// proprietary Feishu icon library is not represented by placeholder controls.
const EMOJI: EmojiItem[] = [
  ["😀", "微笑", "表情"], ["😃", "开心", "表情"], ["😊", "笑脸", "表情"], ["🥰", "喜欢", "表情"], ["😍", "爱心眼", "表情"], ["😎", "墨镜", "表情"], ["🤔", "思考", "表情"], ["🥳", "庆祝", "表情"], ["😂", "笑哭", "表情"], ["👋", "挥手", "表情"], ["👍", "赞", "表情"], ["🙌", "举手", "表情"],
  ["🐱", "猫", "动物"], ["🐶", "狗", "动物"], ["🐻", "熊", "动物"], ["🐼", "熊猫", "动物"], ["🦊", "狐狸", "动物"], ["🐰", "兔子", "动物"], ["🐳", "鲸鱼", "动物"], ["🦋", "蝴蝶", "动物"],
  ["🍎", "苹果", "食物"], ["🍉", "西瓜", "食物"], ["🍓", "草莓", "食物"], ["🍋", "柠檬", "食物"], ["🍰", "蛋糕", "食物"], ["☕", "咖啡", "食物"], ["🍵", "茶", "食物"], ["🍕", "披萨", "食物"],
  ["📄", "文档", "物品"], ["📌", "图钉", "物品"], ["📚", "书", "物品"], ["📝", "笔记", "物品"], ["💡", "灵感", "物品"], ["📅", "日历", "物品"], ["🚀", "火箭", "物品"], ["💻", "电脑", "物品"], ["🎯", "目标", "物品"], ["📣", "公告", "物品"],
  ["⭐", "星星", "符号"], ["✨", "闪光", "符号"], ["❤️", "爱心", "符号"], ["✅", "完成", "符号"], ["🔥", "火", "符号"], ["🎉", "庆祝", "符号"], ["🌈", "彩虹", "符号"], ["🌟", "闪亮的星", "符号"],
].map(([value, name, category]) => ({ value, name, category: category as EmojiItem["category"] }));
const CATEGORIES = ["全部", "表情", "动物", "食物", "物品", "符号"] as const;

export function iconVersion(value: unknown): IconVersion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  // Legacy records can contain an icon no longer accepted for new writes;
  // keep the version usable so the user can replace or remove that value.
  if (typeof item.icon !== "string" || !Number.isSafeInteger(item.revision) || (item.revision as number) < 0) return undefined;
  return { icon: item.icon, revision: item.revision as number };
}

export function iconErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return "图标已被其他人修改，请重新选择。";
  if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return "无法修改图标：文档不存在或当前没有编辑权限。";
  if (error instanceof ApiError && error.status === 400) return "这个图标无法使用，请选择其他表情。";
  return "更新结果可能尚未确认，请重新打开后核对。";
}

/** Verify authorization and the observed revision before issuing a write. */
export async function changeDocumentIcon(
  id: number, previous: IconVersion, next: string,
  getDoc: () => Promise<DocMeta>, getIcon: () => Promise<unknown>,
  write: (icon: string, revision: number) => Promise<unknown>, current: () => boolean,
): Promise<IconVersion | undefined> {
  if (!current()) throw new Error("页面状态已变化");
  const meta = await getDoc();
  if (!current()) throw new Error("页面状态已变化");
  if (meta.id !== id || (meta.role !== "edit" && meta.role !== "manage")) throw new ApiError(403, "forbidden", "当前没有编辑权限");
  const latest = iconVersion(await getIcon());
  if (!current()) throw new Error("页面状态已变化");
  if (!latest || latest.revision !== previous.revision || latest.icon !== previous.icon) throw new ApiError(409, "icon_conflict", "图标已变化");
  const result = await write(next, previous.revision);
  if (!current()) return undefined;
  const committed = result === undefined ? undefined : iconVersion(result);
  if (result !== undefined && (!committed || committed.icon !== next || committed.revision <= previous.revision)) throw new Error("响应无效");
  // The write response can arrive after another writer has changed the icon.
  // Read the current authorized resource rather than publishing that response.
  // 204 similarly means the write committed but access changed before reply.
  const verified = await getDoc();
  if (!current() || verified.id !== id || (verified.role !== "edit" && verified.role !== "manage")) return undefined;
  const authoritative = iconVersion(await getIcon());
  if (!current()) return undefined;
  if (!authoritative || (committed && authoritative.revision < committed.revision)) throw new Error("响应无效");
  return authoritative;
}

export function DocumentIconEditor({ id, userId, icon, enabled, onUpdated, onRevalidate, children }: {
  id: number; userId: number; icon?: string; enabled: boolean; onUpdated: (icon: string) => void | Promise<void>; onRevalidate: () => void; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState<IconVersion>();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("全部");
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const epoch = useRef(0);
  const context = useRef({ id, userId, enabled, mounted: true });
  useLayoutEffect(() => {
    context.current = { id, userId, enabled, mounted: true };
    return () => { context.current.mounted = false; epoch.current++; };
  }, [id, userId, enabled]);
  const valid = (run: number) => context.current.mounted && context.current.enabled && context.current.id === id && context.current.userId === userId && epoch.current === run;
  const close = (restoreFocus = false) => { epoch.current++; setOpen(false); setBusy(false); setVersion(undefined); setError(""); if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus()); };
  useEffect(() => { if (!enabled) { epoch.current++; setOpen(false); setBusy(false); setVersion(undefined); } }, [enabled]);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: MouseEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(true); } };
    document.addEventListener("mousedown", pointer); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", pointer); document.removeEventListener("keydown", key); };
  }, [open]);
  const apply = async (next: string, previous: IconVersion, run: number) => {
    let sent = false;
    let result: IconVersion | undefined;
    try {
      result = await changeDocumentIcon(id, previous, next, () => docsApi.get(id), () => docsApi.getIcon(id), (value, revision) => { sent = true; return docsApi.setIcon(id, value, revision); }, () => valid(run));
    } finally {
      // A request can commit after the picker closes. Refresh only the same
      // still-mounted account/document; never write a late result into the
      // state of another session.
      if (sent && (!valid(run) || !result) && context.current.mounted && context.current.id === id && context.current.userId === userId) onRevalidate();
    }
    if (!valid(run)) return;
    if (!result) { setOpen(false); return; }
    setVersion(result); await onUpdated(result.icon);
  };
  const begin = async () => {
    if (!enabled || busy) return;
    const run = ++epoch.current;
    setOpen(true); setBusy(true); setError(""); setSearch(""); setCategory("全部");
    try {
      const meta = await docsApi.get(id);
      if (!valid(run)) return;
      if (meta.id !== id || (meta.role !== "edit" && meta.role !== "manage")) throw new ApiError(403, "forbidden", "当前没有编辑权限");
      const latest = iconVersion(await docsApi.getIcon(id));
      if (!valid(run)) return;
      if (!latest) throw new Error("响应无效");
      setVersion(latest); await onUpdated(latest.icon);
      if (!valid(run)) return;
      // Feishu's empty-document entry inserts a random icon on the first click.
      if (!icon && !latest.icon) await apply(EMOJI[Math.floor(Math.random() * EMOJI.length)].value, latest, run);
    } catch (e) { if (valid(run)) { setError(iconErrorMessage(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) onRevalidate(); } }
    finally { if (valid(run)) setBusy(false); }
  };
  const choose = async (next: string) => {
    if (!enabled || busy || !version) return;
    const run = ++epoch.current;
    setBusy(true); setError("");
    try { await apply(next, version, run); }
    catch (e) { if (valid(run)) { setError(iconErrorMessage(e)); setVersion(undefined); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) onRevalidate(); } }
    finally { if (valid(run)) setBusy(false); }
  };
  const visible = EMOJI.filter((item) => (category === "全部" || item.category === category) && (!search.trim() || `${item.value} ${item.name}`.includes(search.trim())));
  const glyph = displayDocumentIcon(icon);
  return <div className="group/doc-icon relative">
    {!glyph && enabled && <button ref={trigger} type="button" aria-label="添加图标" onClick={begin} disabled={busy} className="absolute -top-9 left-0 inline-flex h-7 items-center gap-1 rounded px-1.5 text-[13px] text-subtle opacity-0 hover:bg-hover group-hover/doc-icon:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 disabled:opacity-50"><SmilePlus size={14}/>添加图标</button>}
    <div className="flex min-w-0 items-start gap-2">
      {glyph && (enabled ? <button ref={trigger} type="button" aria-label="更换文档图标" title="更换图标" onClick={begin} disabled={busy} className="grid size-10 shrink-0 place-items-center rounded text-[32px] leading-none hover:bg-hover disabled:opacity-50">{glyph}</button> : <span aria-label="文档图标" className="grid size-10 shrink-0 place-items-center text-[32px] leading-none">{glyph}</span>)}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
    {open && enabled && <div ref={panel} role="dialog" aria-label="选择文档图标" className="absolute left-0 top-full z-30 mt-2 w-[min(456px,calc(100vw-56px))] overflow-hidden rounded-lg border bg-surface text-foreground shadow-xl">
      <div className="flex h-12 items-center justify-between border-b px-4"><span className="border-b-2 border-primary py-3 text-[13px] text-primary">表情符号</span><button type="button" disabled={busy || !version?.icon} onClick={() => void choose("")} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[13px] text-muted-foreground hover:bg-hover disabled:opacity-40"><Trash2 size={14}/>移除</button></div>
      <div className="flex gap-2 px-4 pt-3"><label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5"><Search size={15} className="text-subtle"/><input type="search" aria-label="搜索表情" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索" className="h-9 min-w-0 flex-1 bg-transparent text-[16px] outline-none sm:text-[13px]"/></label><button type="button" aria-label="随机图标" title="随机" disabled={busy || !version} onClick={() => void choose(EMOJI[Math.floor(Math.random() * EMOJI.length)].value)} className="grid size-9 place-items-center rounded-md border text-muted-foreground hover:bg-hover disabled:opacity-40"><Shuffle size={15}/></button></div>
      <div className="flex gap-1 overflow-x-auto px-4 pt-3">{CATEGORIES.map((name) => <button type="button" key={name} onClick={() => setCategory(name)} aria-pressed={category === name} className={cn("shrink-0 rounded px-2 py-1 text-[12px]", category === name ? "bg-accent text-primary" : "text-muted-foreground hover:bg-hover")}>{name}</button>)}</div>
      <div className="grid max-h-60 grid-cols-8 gap-1 overflow-y-auto p-4 sm:grid-cols-10">{visible.map((item) => <button type="button" key={`${item.category}:${item.value}`} title={item.name} aria-label={item.name} disabled={busy || !version} onClick={() => void choose(item.value)} className="grid aspect-square place-items-center rounded text-[22px] hover:bg-hover focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40">{item.value}</button>)}</div>
      {busy && <p role="status" className="px-4 pb-3 text-[12px] text-subtle">正在验证图标设置…</p>}
      {error && <p role="alert" className="px-4 pb-3 text-[12px] text-destructive">{error} <button type="button" onClick={() => void begin()} className="underline">重新验证</button></p>}
      {!busy && !visible.length && <p className="px-4 pb-3 text-[12px] text-subtle">没有找到表情</p>}
    </div>}
  </div>;
}
