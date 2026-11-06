import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, docsApi, type DocMeta, type Role, type ShareInfo } from "@/lib/api";
import { colorFor } from "@/lib/presence";
import { Avatar } from "@/components/brand";
import { AddIcon, ArrowDownIcon, ArrowRightIcon, BuildingIcon, HelpIcon, LinkIcon, SettingIcon } from "@/components/FeishuIcons";
import { Check, X } from "lucide-react";

export const ROLE_LABEL: Record<string, string> = { view: "可阅读", edit: "可编辑", manage: "可管理", anon: "任何人可读", none: "关闭" };

export function ShareDialog({ meta, onClose, anchorRef }: { meta: DocMeta; onClose: () => void; anchorRef?: RefObject<HTMLButtonElement | null> }) {
  const qc = useQueryClient();
  const key = ["shares", meta.id];
  const info = useQuery({ queryKey: key, queryFn: () => docsApi.shares(meta.id) });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("edit");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const initialFocusDone = useRef(false);
  useEffect(() => { if (!info.data || initialFocusDone.current) return; initialFocusDone.current = true; if (typeof window.matchMedia === "function" && window.matchMedia("(min-width: 640px)").matches) emailRef.current?.focus(); }, [info.data]);
  useLayoutEffect(() => {
    const place = () => {
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const width = Math.min(480, Math.max(0, viewportWidth - 32));
      const rect = anchorRef?.current?.getBoundingClientRect();
      const left = rect ? Math.max(leftEdge + 16, Math.min(rect.right - width, leftEdge + viewportWidth - width - 16)) : leftEdge + viewportWidth - width - 16;
      const top = Math.max(topEdge + 8, Math.min(rect ? rect.bottom + 6 : topEdge + 64, topEdge + viewportHeight - 120));
      setPosition({ width, left, top, maxHeight: Math.max(100, topEdge + viewportHeight - top - 16) });
    };
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => { window.removeEventListener("resize", place); window.visualViewport?.removeEventListener("resize", place); window.visualViewport?.removeEventListener("scroll", place); };
  }, [anchorRef]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("keydown", close); anchorRef?.current?.focus(); };
  }, [anchorRef]);
  const manage = info.data?.role === "manage";
  const set = (d: ShareInfo) => qc.setQueryData(key, d);
  const invite = useMutation({
    mutationFn: (v: { email: string; role: Role | "" }) => docsApi.share(meta.id, v.email, v.role),
    onSuccess: (d) => { set(d); setEmail(""); setErr(""); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "邀请失败"),
  });
  const link = useMutation({ mutationFn: (r: "none" | "anon" | "view" | "edit") => docsApi.setLink(meta.id, r), onSuccess: (l) => info.data && set({ ...info.data, link: l }) });
  const linkRole = info.data?.link.role ?? "none";
  const url = info.data?.link.token ? `${location.origin}/#/${linkRole === "anon" ? "p" : "s"}/${info.data.link.token}` : "";
  const linkTitle = linkRole === "none" ? "仅指定协作者" : linkRole === "anon" ? "互联网上任何人" : "已登录用户";
  const linkDescription = linkRole === "none" ? "仅邀请的协作者可访问" : linkRole === "anon" ? "获得链接的人可阅读" : `获得链接的登录用户${ROLE_LABEL[linkRole] ?? "可访问"}`;
  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <section role="dialog" aria-labelledby="share-title" data-share-dialog onMouseDown={(event) => event.stopPropagation()} style={position ? { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight } : { right: 16, top: 54, width: "min(480px, calc(100vw - 32px))" }} className="fixed max-h-[calc(100vh-4rem)] overflow-y-auto rounded-lg border bg-surface text-[14px] shadow-[0_8px_24px_rgba(31,35,41,0.16)]">
        <header className="flex h-[45px] items-center justify-between px-4">
          <h2 id="share-title" className="flex items-center gap-1 text-[16px] font-semibold">分享{meta.kind === "base" ? "多维表格" : "文档"}<HelpIcon className="size-[13px] text-muted-foreground" /></h2>
          <div className="flex items-center gap-1"><button type="button" onClick={() => setShowMembers((v) => !v)} aria-expanded={showMembers} className="flex h-7 items-center gap-1 rounded-md px-1 text-[13px] text-muted-foreground hover:bg-hover" title="查看协作者及权限"><SettingIcon className="size-[14px]" />权限设置</button><button type="button" onClick={onClose} aria-label="关闭分享" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover sm:sr-only sm:focus:not-sr-only"><X size={15}/></button></div>
        </header>
        {info.isPending && <p className="px-4 py-2 text-[13px] text-subtle">正在加载分享设置…</p>}
        {info.isError && <p role="alert" className="px-4 py-2 text-[13px] text-destructive">加载分享设置失败，请关闭后重试。</p>}
        {info.data && <>
          <div className="flex h-[54px] items-center justify-between px-4">
            <span className="font-medium">邀请协作者</span>
            <button type="button" className="flex items-center gap-1 rounded-md px-1 py-1 hover:bg-hover" onClick={() => setShowMembers((v) => !v)} aria-label="查看协作者" aria-expanded={showMembers}><Avatar name={meta.creatorName} color={colorFor(meta.creatorId - 1)} size={26} /><ArrowRightIcon className={`size-3 text-subtle transition-transform ${showMembers ? "rotate-90" : ""}`} /></button>
          </div>
          {showMembers && <div className="mx-4 mb-3 max-h-44 space-y-3 overflow-y-auto rounded-md bg-sidebar/60 p-3">
            <div className="flex items-center gap-2"><Avatar name={meta.creatorName} color={colorFor(meta.creatorId - 1)} size={28}/><span className="min-w-0 flex-1 truncate">{meta.creatorName}</span><span className="text-[13px] text-muted-foreground">所有者</span></div>
            {info.data.members.map((m) => <div key={m.userId} className="flex items-center gap-2"><Avatar name={m.name} color={colorFor(m.userId - 1)} size={28}/><span className="min-w-0 flex-1 truncate">{m.name}</span>{manage ? <RoleSelect label={`${m.name}的权限`} value={m.role} options={["view", "edit", "manage", "remove"]} onChange={(r) => invite.mutate({ email: m.email, role: r === "remove" ? "" : r as Role })} /> : <span className="text-[13px] text-muted-foreground">{ROLE_LABEL[m.role]}</span>}</div>)}
          </div>}
          {manage && <form className="mx-4 flex h-9 items-center rounded-md border border-input focus-within:border-primary" onSubmit={(e) => { e.preventDefault(); if (email.trim()) invite.mutate({ email: email.trim(), role }); }}>
            <input ref={emailRef} aria-label="协作者邮箱" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="输入邮箱，邀请协作者" className="h-full min-w-0 flex-1 bg-transparent px-3 text-[16px] outline-none placeholder:text-subtle sm:text-[14px]" />
            {email.trim() && <RoleSelect label="邀请权限" value={role} options={["view", "edit", "manage"]} onChange={(r) => setRole(r as Role)} />}
            <button type="submit" disabled={!email.trim() || invite.isPending} aria-label="邀请协作者" className="grid h-full w-9 shrink-0 place-items-center border-l text-muted-foreground hover:bg-hover disabled:opacity-45"><AddIcon className="size-4"/></button>
          </form>}
          {err && <p role="alert" className="px-4 pt-2 text-[12px] text-destructive">{err}</p>}
          <div className="px-4 pb-6 pt-7">
            <p className="mb-4 font-medium">链接分享</p>
            <div className="flex items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-[#1456f0] text-white"><BuildingIcon className="size-[15px]" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate leading-5">{linkTitle}</span><span className="block truncate text-[12px] text-subtle">{linkDescription}</span></span>
              {manage ? <RoleSelect label="链接分享权限" value={linkRole} onChange={(r) => link.mutate(r as "none" | "anon" | "view" | "edit")} options={meta.kind === "base" ? ["none", "view", "edit"] : ["none", "anon", "view", "edit"]} /> : <span className="text-[13px] text-muted-foreground">{ROLE_LABEL[linkRole]}</span>}
            </div>
            {link.isError && <p role="alert" className="pt-2 text-[12px] text-destructive">更新链接权限失败，请重试。</p>}
          </div>
          <footer className="flex min-h-[66px] items-center gap-2 bg-sidebar px-4 py-3">
            <button type="button" disabled={!url || linkRole === "none"} title={!url || linkRole === "none" ? "开启链接分享后可复制链接" : "复制链接"} className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50" onClick={async () => { try { if (!navigator.clipboard) throw new Error("clipboard unavailable"); await navigator.clipboard.writeText(url); setCopyError(false); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopyError(true); } }}>{copied ? <Check size={14}/> : <LinkIcon className="size-[14px]"/>}{copied ? "已复制" : "复制链接"}</button>
            {url && <span className="sr-only" data-share-url>{url}</span>}
            {copyError && <input readOnly aria-label="分享链接" value={url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded border bg-surface px-2 py-1 text-[12px]" />}
          </footer>
          {copyError && <p role="alert" className="bg-sidebar px-4 pb-3 text-[12px] text-destructive">复制失败，请手动选择链接。</p>}
        </>}
      </section>
    </div>
  );
}
function RoleSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (r: string) => void; options: string[] }) {
  return <label className="relative inline-flex shrink-0 items-center"><span className="sr-only">{label}</span><select value={value} onChange={(e) => onChange(e.target.value)} className="h-8 cursor-pointer appearance-none rounded-md bg-transparent pl-2 pr-5 text-[13px] text-muted-foreground outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40">{options.map((o) => <option key={o} value={o}>{o === "remove" ? "移除" : ROLE_LABEL[o]}</option>)}</select><ArrowDownIcon className="pointer-events-none absolute right-1.5 size-2 text-subtle"/></label>;
}
