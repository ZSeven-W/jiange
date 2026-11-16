import { useEffect, useRef, useState } from "react";
import { ReadOnlyDoc } from "./read-only-doc";
import { PublicDocumentCover } from "@/components/document-cover";
import { Logo } from "@/components/brand";
import { fetchPublicDoc, initialPublicDocState, mayCopyPublicBlockLink, publicDocumentPermissions, updatePublicDocState, type PublicDocState, type PublicIssue } from "./public-doc-state";
import { publicBlockKey, publicBlockLink } from "./public-block-links";

/** Explain a failed public link without discarding its token on sign-in. */
export function PublicDocMessage({ issue, token, onRetry }: { issue: PublicIssue; token: string; onRetry: () => void }) {
  return <div className="py-24 text-center">
    <p className="text-[15px] text-muted-foreground">{issue === "login" ? "此链接需要登录后访问" : issue === "expired" ? "链接已失效或已关闭分享" : issue === "unsupported_table" ? "当前版本无法安全显示此文档中的表格内容，请联系文档所有者。" : "暂时无法连接服务器"}</p>
    {issue === "login" ? <a href={`#/s/${encodeURIComponent(token)}`} className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-[13px] text-white">登录后访问</a> : issue === "temporary" ? <button type="button" onClick={onRetry} className="mt-4 rounded-md bg-primary px-4 py-2 text-[13px] text-white">重试</button> : <a href="#/" className="mt-4 inline-block text-[13px] text-primary">返回主页</a>}
  </div>;
}

/** 匿名只读文档页：/#/p/{token}（链接分享角色为「任何人可读」时可用）。 */
export function PublicDoc({ token }: { token: string }) {
  const [state, setState] = useState(() => initialPublicDocState(token));
  const [verification, setVerification] = useState<{ token: string; inFlight: boolean }>({ token, inFlight: true });
  const [coverRecovery, setCoverRecovery] = useState<{ token: string; count: number }>({ token, count: 0 });
  const [notice, setNotice] = useState("");
  const [, setNavigation] = useState(0);
  const refreshRef = useRef<() => void>(() => {});
  const bodyRef = useRef<HTMLDivElement>(null);
  const anchored = useRef<string | null>(null);
  const highlight = useRef<{ element: HTMLElement; timer: number } | null>(null);
  const authority = useRef<{ token: string; state: PublicDocState; refreshing: boolean }>({ token, state, refreshing: true });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const clear = () => { const current = highlight.current; if (current) { window.clearTimeout(current.timer); current.element.removeAttribute("data-block-linked"); highlight.current = null; } };
    const changed = () => { anchored.current = null; clear(); setNavigation((value) => value + 1); };
    window.addEventListener("hashchange", changed);
    return () => { window.removeEventListener("hashchange", changed); clear(); };
  }, [token]);
  useEffect(() => {
    let active = true, inFlight = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      if (active) setVerification({ token, inFlight: true });
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => request.abort(), 15_000);
      const result = await fetchPublicDoc(token, request.signal);
      window.clearTimeout(timeout);
      if (active) {
        setState((previous) => updatePublicDocState(previous, token, result));
        if ("snapshot" in result) setCoverRecovery((previous) => ({ token, count: previous.token === token ? previous.count + 1 : 1 }));
        setVerification({ token, inFlight: document.visibilityState === "hidden" });
      }
      inFlight = false;
    };
    refreshRef.current = () => { void refresh(); };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 5000);
    const visible = () => {
      if (document.visibilityState === "hidden") setVerification({ token, inFlight: true });
      else void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      refreshRef.current = () => {};
    };
  }, [token]);
  // Never display a previous token's snapshot during a route transition.
  const current = state.token === token ? state : initialPublicDocState(token);
  const snap = current.snapshot;
  const issue = current.issue;
  // A retained offline snapshot is useful for reading, but is not proof that
  // its public link and its permissions are still valid.
  const permissions = publicDocumentPermissions(current, token, verification.token !== token || verification.inFlight);
  authority.current = { token, state: current, refreshing: verification.token !== token || verification.inFlight };
  useEffect(() => {
    const key = publicBlockKey(window.location.hash, token);
    if (!key || anchored.current === key) return;
    const el = [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-public-block]") ?? [])].find((item) => item.dataset.publicBlock === key);
    if (!el) return;
    anchored.current = key;
    el.scrollIntoView({ block: "center" });
    el.setAttribute("data-block-linked", "true");
    const timer = window.setTimeout(() => { el.removeAttribute("data-block-linked"); if (highlight.current?.timer === timer) highlight.current = null; }, 2000);
    highlight.current = { element: el, timer };
  });
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 3000); return () => window.clearTimeout(timer); }, [notice]);
  const copyBlockLink = (block: string) => {
    const state = authority.current;
    if (state.token !== token || !mayCopyPublicBlockLink(state.state, token, state.refreshing, document.visibilityState !== "hidden", block)) { setNotice("分享状态尚未确认，请稍后重试。"); return; }
    const url = publicBlockLink(window.location.href, token, block);
    if (!url || !navigator.clipboard?.writeText) { setNotice("无法复制链接，请检查浏览器剪贴板权限。"); return; }
    void navigator.clipboard.writeText(url).then(() => { if (mounted.current && authority.current.token === token) setNotice("已复制块链接"); }, () => { if (mounted.current && authority.current.token === token) setNotice("无法复制链接，请检查浏览器剪贴板权限。"); });
  };
  useEffect(() => {
    document.title = `${snap?.title.trim() || "公开文档"} - Jiange`;
  }, [snap?.title]);
  return (
    <div className="min-h-full bg-background" data-public-doc onCopy={(e) => { if (!permissions.copy) e.preventDefault(); }} onCut={(e) => { if (!permissions.copy) e.preventDefault(); }}>
      <header className="flex h-[52px] items-center border-b px-6">
        <a href="#/" aria-label="Jiange 主页">
          <Logo className="gap-1.5" markClassName="size-6" wordmarkClassName="h-[15px]" />
        </a>
        <span className="ml-3 rounded bg-accent px-2 py-0.5 text-[12px] font-medium text-accent-foreground">只读分享</span>
      </header>
      {snap && <PublicDocumentCover value={snap.cover} token={token} recovery={coverRecovery.token === token ? coverRecovery.count : 0} allowCopy={permissions.copy} allowPrint={permissions.download}/>}
      <div className="mx-auto max-w-[820px] px-10 pb-40 pt-16" data-document-print-restricted={!permissions.download ? "true" : undefined}>
        {issue && !snap && <PublicDocMessage issue={issue} token={token} onRetry={() => refreshRef.current()} />}
        {!snap && !issue && <p className="py-24 text-center text-[13px] text-subtle">正在加载文档…</p>}
        {snap && (
          <>
            {issue === "temporary" && <div role="status" className="mb-4 rounded-md bg-[#FFF7E8] px-3 py-2 text-[13px] text-[#8C5A00]">暂时无法连接，当前显示上次加载的内容；分享状态尚未重新确认。 <button type="button" className="underline" onClick={() => refreshRef.current()}>重试</button></div>}
            <h1 className="text-[34px] font-semibold leading-[1.3] tracking-tight">{snap.title || "未命名文档"}</h1>
            <div className="mt-3 text-[13px] text-subtle">最近修改于 {new Date(snap.updatedAt).toLocaleString("zh-CN", { hour12: false })}</div>
            <div ref={bodyRef} className="mt-8">
              <ReadOnlyDoc view={snap.view} publicToken={token} disableFileDownloads={!permissions.download} imageRecovery={current.recovery} onCopyBlockLink={copyBlockLink} />
            </div>
          </>
        )}
      </div>
      {notice && <div role="status" className="fixed bottom-8 left-1/2 z-50 -translate-x-1/2 rounded-md bg-[#1F2329]/90 px-3.5 py-2 text-[13px] text-white shadow-lg">{notice}</div>}
    </div>
  );
}
