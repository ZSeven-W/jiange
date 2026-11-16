import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, docsApi } from "@/lib/api";
import { hrefOf } from "@/components/sidebar";

/** #/s/:token — accepts a share link, then opens the doc. */
export function JoinLink({ token, userId }: { token: string; userId: number }) {
  const qc = useQueryClient();
  const [err, setErr] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setErr("");
    docsApi
      .joinForAccount(token, userId, controller.signal)
      .then((d) => {
        if (!active) return;
        qc.invalidateQueries({ queryKey: ["shared"] });
        location.replace(hrefOf(d));
      })
      .catch((error) => { if (active) setErr(error instanceof ApiError && error.status === 404 ? "链接已失效，或当前账号不在允许的访问范围内" : error instanceof ApiError && error.status === 401 ? "登录状态已失效，请重新登录" : "暂时无法打开链接，请稍后重试"); });
    return () => { active = false; controller.abort(); };
  }, [token, userId, qc, attempt]);
  return <div className="grid flex-1 place-items-center px-6 text-center text-muted-foreground"><div>{err || "正在打开分享的文档…"}{err && <div><button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-3 rounded border px-3 py-1.5 text-[13px] text-foreground hover:bg-hover">重试</button></div>}</div></div>;
}
