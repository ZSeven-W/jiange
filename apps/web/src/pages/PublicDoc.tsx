import { useEffect, useState } from "react";
import { ReadOnlyDoc } from "./ReadOnlyDoc";

interface PublicSnapshot {
  title: string;
  updatedAt: string;
  copyProtected?: boolean;
  view: import("@/lib/api").DocView;
}

/** 匿名只读文档页：/#/p/{token}（链接分享角色为「任何人可读」时可用）。 */
export function PublicDoc({ token }: { token: string }) {
  const [snap, setSnap] = useState<PublicSnapshot | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setSnap(null);
    setErr("");
    fetch(`/api/public/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.message ?? "链接已失效");
        }
        setSnap(await r.json());
      })
      .catch((e) => { if (!controller.signal.aborted) setErr(e instanceof Error ? e.message : String(e)); });
    return () => controller.abort();
  }, [token]);
  return (
    <div className="min-h-full bg-background" data-public-doc onCopy={(e) => { if (snap?.copyProtected) e.preventDefault(); }} onCut={(e) => { if (snap?.copyProtected) e.preventDefault(); }}>
      <header className="flex h-[52px] items-center border-b px-6">
        <a href="#/" className="text-[15px] font-semibold text-primary">
          Jiange
        </a>
        <span className="ml-3 rounded bg-accent px-2 py-0.5 text-[12px] font-medium text-accent-foreground">只读分享</span>
      </header>
      <div className="mx-auto max-w-[820px] px-10 pb-40 pt-16">
        {err && (
          <div className="py-24 text-center">
            <p className="text-[15px] text-muted-foreground">{err}</p>
            <a href="#/login" className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-[13px] text-white">
              登录 Jiange
            </a>
          </div>
        )}
        {snap && (
          <>
            <h1 className="text-[34px] font-semibold leading-[1.3] tracking-tight">{snap.title || "未命名文档"}</h1>
            <div className="mt-3 text-[13px] text-subtle">最近修改于 {new Date(snap.updatedAt).toLocaleString("zh-CN", { hour12: false })}</div>
            <div className="mt-8">
              <ReadOnlyDoc view={snap.view} publicToken={token} disableFileDownloads={snap.copyProtected} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
