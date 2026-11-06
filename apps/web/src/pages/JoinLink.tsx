import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { docsApi } from "@/lib/api";
import { hrefOf } from "@/components/Sidebar";

/** #/s/:token — accepts a share link, then opens the doc. */
export function JoinLink({ token }: { token: string }) {
  const qc = useQueryClient();
  const [err, setErr] = useState("");
  useEffect(() => {
    docsApi
      .join(token)
      .then((d) => {
        qc.invalidateQueries({ queryKey: ["shared"] });
        location.replace(hrefOf(d));
      })
      .catch(() => setErr("链接已失效或已关闭分享"));
  }, [token, qc]);
  return <div className="grid flex-1 place-items-center text-muted-foreground">{err || "正在打开分享的文档…"}</div>;
}
