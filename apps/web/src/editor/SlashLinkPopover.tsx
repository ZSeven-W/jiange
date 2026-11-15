import { useEffect, useLayoutEffect, useState } from "react";
import { safeURL } from "@/lib/safeURL";

export function SlashLinkPopover({ x, y, onConfirm, onCancel, initialText = "" }: { x: number; y: number; initialText?: string; onConfirm: (text: string, url: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState("");
  const [position, setPosition] = useState({ left: 8, top: 8, width: 468 });
  useLayoutEffect(() => {
    const fit = () => {
      const viewport = window.visualViewport, left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = Math.max(1, Math.min(468, (viewport?.width ?? window.innerWidth) - 16));
      const right = left + (viewport?.width ?? window.innerWidth), bottom = top + (viewport?.height ?? window.innerHeight);
      setPosition({ width, left: Math.max(left + 8, Math.min(x - 160, right - width - 8)), top: Math.max(top + 8, Math.min(y + 6, bottom - 136)) });
    };
    fit(); window.addEventListener("resize", fit); window.visualViewport?.addEventListener("resize", fit); window.visualViewport?.addEventListener("scroll", fit);
    return () => { window.removeEventListener("resize", fit); window.visualViewport?.removeEventListener("resize", fit); window.visualViewport?.removeEventListener("scroll", fit); };
  }, [x, y]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); onCancel(); } };
    window.addEventListener("keydown", escape, true); return () => window.removeEventListener("keydown", escape, true);
  }, [onCancel]);
  const valid = !!text.trim() && [...text].length <= 5000 && !!safeURL(url.trim()) && url.trim().length <= 8192;
  return <form role="dialog" aria-label="插入链接" contentEditable={false} data-slash-link style={position} className="fixed z-[70] rounded-md border border-[#dee0e3] bg-white p-4 text-[13px] text-[#1f2329] shadow-[0_6px_24px_rgba(31,35,41,0.16)]" onSubmit={(event) => { event.preventDefault(); if (valid) onConfirm(text, url.trim()); }}>
    <label className="flex items-center gap-2"><span className="w-8 shrink-0">文本</span><input autoFocus={!initialText} aria-label="链接文本" value={text} maxLength={10000} onChange={(event) => setText(event.target.value)} placeholder="输入文本" className="h-8 min-w-0 flex-1 rounded border border-[#dee0e3] px-2 text-base outline-none focus:border-[#3370ff] sm:text-[13px]"/><span aria-hidden="true" className="w-[66px] shrink-0"/></label>
    <div className="mt-3 flex items-center gap-2"><label className="flex min-w-0 flex-1 items-center gap-2"><span className="w-8 shrink-0">链接</span><input autoFocus={!!initialText} aria-label="链接地址" value={url} maxLength={8192} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴或输入链接" className="h-8 min-w-0 flex-1 rounded border border-[#dee0e3] px-2 text-base outline-none focus:border-[#3370ff] sm:text-[13px]"/></label><button type="submit" disabled={!valid} className="h-8 shrink-0 rounded bg-[#3370ff] px-5 text-white hover:bg-[#245bdb] disabled:cursor-not-allowed disabled:bg-[#c5c9cf]">确认</button></div>
  </form>;
}
