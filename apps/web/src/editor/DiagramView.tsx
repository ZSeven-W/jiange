import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";

let initialized = false;
function ensureInit(dark: boolean) {
  if (!initialized) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", fontFamily: "PingFang SC, Microsoft YaHei, sans-serif" });
    initialized = true;
  }
}

/** Mermaid 流程图渲染（graph TD / sequenceDiagram / gantt…）。失败时显示错误提示。 */
export function DiagramView({ src }: { src: string }) {
  const [svg, setSvg] = useState("");
  const [err, setErr] = useState("");
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const dark = document.documentElement.classList.contains("dark");
  const lastSrc = useRef(src);
  useEffect(() => {
    let alive = true;
    lastSrc.current = src;
    setErr("");
    ensureInit(dark);
    mermaid
      .render(`jiange-dia-${id}`, src)
      .then((r) => {
        if (alive && lastSrc.current === src) setSvg(r.svg);
      })
      .catch((e) => {
        if (alive && lastSrc.current === src) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [src, dark, id]);
  if (err) {
    return (
      <div className="rounded-md bg-destructive/10 px-3 py-2 text-[12px] text-destructive" data-diagram-error>
        流程图语法错误：{err.split("\n")[0]}
      </div>
    );
  }
  // mermaid svg 自带 max-width；注入容器让它自适应
  return <div className="[&>svg]:mx-auto [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} data-diagram-svg />;
}
