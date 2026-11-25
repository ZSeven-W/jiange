import { useEffect, useRef, useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { verifyPublicLinkPassword } from "@/lib/share-password-api";
import { ReadOnlyDoc } from "./read-only-doc";
import { PublicDocumentCover } from "@/components/document-cover";
import { DocumentWatermark } from "@/components/document-watermark";
import { Logo } from "@/components/brand";
import { fetchPublicDoc, initialPublicDocState, mayCopyPublicBlockLink, publicDocumentPermissions, updatePublicDocState, type PublicDocState, type PublicIssue, type PublicSnapshot } from "./public-doc-state";
import { publicBlockKey, publicBlockLink } from "./public-block-links";

/** Sleek Feishu-style password gate card for encrypted share links. */
export function PublicPasswordGate({
  token,
  onVerified,
  title,
  description,
}: {
  token: string;
  onVerified: () => void;
  title?: string;
  description?: string;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = password.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await verifyPublicLinkPassword(token, trimmed);
      setPassword("");
      onVerified();
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_password") {
        setError(t("访问密码错误，请重新输入"));
      } else if (e instanceof ApiError && e.status === 404) {
        setError(t("链接已失效或已关闭分享"));
      } else {
        setError(e instanceof ApiError ? e.message : t("验证失败，请稍后重试"));
      }
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="flex justify-center py-20">
      <div
        data-public-password-gate
        className="w-full max-w-[380px] rounded-xl border bg-surface p-6 text-center shadow-[0_8px_24px_rgba(31,35,41,0.08)]"
      >
        <div className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-primary/10 text-primary">
          <Lock size={20} />
        </div>
        <h2 className="text-[17px] font-semibold text-foreground">
          {title ?? t("此分享链接已加密")}
        </h2>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {description ?? t("请输入访问密码（提取码）以查看文档")}
        </p>
        <form onSubmit={submit} className="mt-5 space-y-3 text-left">
          <input
            type="password"
            data-public-password-input
            autoFocus
            autoComplete="off"
            maxLength={32}
            value={password}
            onChange={(e) => { setPassword(e.target.value); if (error) setError(""); }}
            disabled={submitting}
            placeholder={t("请输入访问密码")}
            aria-label={t("访问密码")}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-[14px] outline-none placeholder:text-subtle focus:border-primary disabled:opacity-50"
          />
          {error && (
            <p role="alert" data-public-password-error className="text-[12px] text-destructive">
              {error}
            </p>
          )}
          <button
            type="submit"
            data-public-password-submit
            disabled={submitting || !password.trim()}
            className="h-10 w-full rounded-md bg-primary text-[14px] font-medium text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? t("正在验证…") : t("验证并访问")}
          </button>
        </form>
      </div>
    </div>
  );
}

/** Explain a failed public link without discarding its token on sign-in. */
export function PublicDocMessage({ issue, token, onRetry }: { issue: PublicIssue; token: string; onRetry: () => void }) {
  const { t } = useI18n();
  if (issue === "password_required") {
    return <PublicPasswordGate token={token} onVerified={onRetry} />;
  }
  return <div className="py-24 text-center">
    <p className="text-[15px] text-muted-foreground">{issue === "login" ? t("此链接需要登录后访问") : issue === "expired" ? t("链接已失效或已关闭分享") : issue === "unsupported_table" ? t("当前版本无法安全显示此文档中的表格内容，请联系文档所有者。") : issue === "table_unavailable" ? t("表格数据暂时无法安全显示，请稍后重试或联系文档所有者。") : t("暂时无法连接服务器")}</p>
    {issue === "login" ? <a href={`#/s/${encodeURIComponent(token)}`} className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-[13px] text-white">{t("登录后访问")}</a> : issue === "temporary" || issue === "table_unavailable" ? <button type="button" onClick={onRetry} className="mt-4 rounded-md bg-primary px-4 py-2 text-[13px] text-white">{t("重试")}</button> : <a href="#/" className="mt-4 inline-block text-[13px] text-primary">{t("返回主页")}</a>}
  </div>;
}

/** 匿名只读文档页：/#/p/{token}（链接分享角色为「任何人可读」时可用）。 */
export function PublicDoc({ token, initialSnapshot }: { token: string; initialSnapshot?: PublicSnapshot }) {
  const { locale, t } = useI18n();
  const [state, setState] = useState<PublicDocState>(() =>
    initialSnapshot ? { token, snapshot: initialSnapshot, issue: null, recovery: 0 } : initialPublicDocState(token),
  );
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
    let active = true, inFlight = false, pending = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      do {
        pending = false;
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
      } while (active && pending);
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
    if (state.token !== token || !mayCopyPublicBlockLink(state.state, token, state.refreshing, document.visibilityState !== "hidden", block)) { setNotice(t("分享状态尚未确认，请稍后重试。")); return; }
    const url = publicBlockLink(window.location.href, token, block);
    if (!url || !navigator.clipboard?.writeText) { setNotice(t("无法复制链接，请检查浏览器剪贴板权限。")); return; }
    void navigator.clipboard.writeText(url).then(() => { if (mounted.current && authority.current.token === token) setNotice(t("已复制块链接")); }, () => { if (mounted.current && authority.current.token === token) setNotice(t("无法复制链接，请检查浏览器剪贴板权限。")); });
  };
  useEffect(() => {
    document.title = `${snap?.title.trim() || t("公开文档")} - Jiange`;
  }, [snap?.title, locale, t]);
  return (
    <div className="min-h-full bg-background" data-public-doc onCopy={(e) => { if (!permissions.copy) e.preventDefault(); }} onCut={(e) => { if (!permissions.copy) e.preventDefault(); }}>
      <header className="flex h-[52px] items-center border-b px-6">
        <a href="#/" aria-label={t("Jiange 主页")}>
          <Logo className="gap-1.5" markClassName="size-6" wordmarkClassName="h-[15px]" />
        </a>
        <span className="ml-3 rounded bg-accent px-2 py-0.5 text-[12px] font-medium text-accent-foreground">{t("只读分享")}</span>
      </header>
      {snap && <DocumentWatermark copyProtected={!!snap.copyProtected} customText={snap.title || undefined} />}
      {snap && <PublicDocumentCover value={snap.cover} token={token} recovery={coverRecovery.token === token ? coverRecovery.count : 0} allowCopy={permissions.copy} allowPrint={permissions.download}/>}
      <div className="mx-auto max-w-[820px] px-10 pb-40 pt-16" data-document-print-restricted={!permissions.download ? "true" : undefined}>
        {issue && !snap && <PublicDocMessage issue={issue} token={token} onRetry={() => refreshRef.current()} />}
        {!snap && !issue && <p className="py-24 text-center text-[13px] text-subtle">{t("正在加载文档…")}</p>}
        {snap && (
          <>
            {issue === "temporary" && <div role="status" className="mb-4 rounded-md bg-[#FFF7E8] px-3 py-2 text-[13px] text-[#8C5A00]">{t("暂时无法连接，当前显示上次加载的内容；分享状态尚未重新确认。")} <button type="button" className="underline" onClick={() => refreshRef.current()}>{t("重试")}</button></div>}
            <h1 className="text-[34px] font-semibold leading-[1.3] tracking-tight">{snap.title || t("未命名文档")}</h1>
            <div className="mt-3 text-[13px] text-subtle">{t("最近修改于 {time}", { time: new Date(snap.updatedAt).toLocaleString(locale === "en" ? "en-US" : "zh-CN", { hour12: false }) })}</div>
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
