import { useEffect, useRef, useState } from "react";
import { Check, Copy, CornerDownLeft, Languages, Loader2, RotateCcw, Settings, Sparkles, X } from "lucide-react";
import { AI_ACTIONS, AI_TRANSLATIONS, aiErrorText, blockPrompt, openAISettings, type AIAction, type AIMessage } from "@/lib/ai";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * 块级 AI 面板（对应飞书块菜单「问问豆包」与「翻译」）：
 * 预设动作 / 自定义指令 → 结果预览 → 替换原文 / 插入到下方 / 复制。结果只在用户确认后写入文档。
 */
export function AIBlockPanel({ x, y, text, context, initial, ai, canEdit, onReplace, onInsert, onClose }: {
  x: number; y: number;
  text: string;
  context?: string;
  initial?: AIAction;
  ai: (messages: AIMessage[]) => Promise<string>;
  canEdit: boolean;
  onReplace: (result: string) => void;
  onInsert: (result: string) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; settings: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [last, setLast] = useState<{ action: AIAction; custom: string } | null>(null);
  const seq = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const run = async (action: AIAction, instruction = "") => {
    if (!text.trim() && action !== "custom") { setError({ text: "当前块没有可处理的文字。", settings: false }); return; }
    const id = ++seq.current;
    setBusy(true); setError(null); setResult(null); setLast({ action, custom: instruction });
    try {
      const out = await ai(blockPrompt(action, text, instruction, context));
      if (id === seq.current) setResult(out);
    } catch (err) {
      if (id === seq.current) setError({ text: aiErrorText(err), settings: err instanceof ApiError && (err.code === "ai_not_configured" || err.code.startsWith("ai_key") || err.code === "ai_auth_failed" || err.code === "invalid_base_url") });
    } finally { if (id === seq.current) setBusy(false); }
  };
  useEffect(() => { if (initial) void run(initial); /* run once for 翻译 shortcuts */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { seq.current++; onClose(); } };
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) { seq.current++; onClose(); } };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [onClose]);
  const chip = "flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] text-foreground hover:border-primary hover:text-primary disabled:opacity-40";
  return <div ref={root} contentEditable={false} className="absolute z-50 w-[min(420px,calc(100vw-24px))] rounded-lg border border-[#D9DBDF] bg-surface p-3 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.16)] dark:border-border" style={{ left: x, top: y }} onMouseDown={(e) => { if (!(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) e.preventDefault(); }} data-ai-block-panel>
    <div className="flex items-center gap-1.5 font-medium"><Sparkles size={15} className="text-primary" />AI<button type="button" aria-label="AI 设置" title="AI 设置" onClick={() => openAISettings()} className="ml-auto grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover"><Settings size={14} /></button><button type="button" aria-label="关闭" onClick={() => { seq.current++; onClose(); }} className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover"><X size={14} /></button></div>
    <div className="mt-2 flex flex-wrap gap-1.5">
      {AI_ACTIONS.map((a) => <button key={a.id} type="button" disabled={busy} onClick={() => void run(a.id)} className={chip} data-ai-action={a.id}>{a.label}</button>)}
      {AI_TRANSLATIONS.map((a) => <button key={a.id} type="button" disabled={busy} onClick={() => void run(a.id)} className={chip} data-ai-action={a.id}><Languages size={12} />{`译为${a.label}`}</button>)}
    </div>
    <form className="mt-2 flex items-center gap-1.5 rounded-md border px-2 focus-within:border-primary" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) void run("custom", custom); }}>
      <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="告诉 AI 要怎么处理这段内容…" maxLength={500} className="h-8 min-w-0 flex-1 bg-transparent outline-none" data-ai-custom />
      <button type="submit" disabled={busy || !custom.trim()} aria-label="发送" className="grid size-6 place-items-center rounded text-primary disabled:opacity-30"><CornerDownLeft size={14} /></button>
    </form>
    {busy && <p role="status" className="mt-3 flex items-center gap-1.5 text-subtle"><Loader2 size={14} className="animate-spin" />AI 正在生成…</p>}
    {error && <div role="alert" className="mt-3 text-destructive">{error.text}{error.settings && <button type="button" onClick={() => openAISettings()} className="ml-2 text-primary underline">去设置</button>}</div>}
    {result !== null && <div className="mt-3">
      <div className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-[#F5F6F7] px-3 py-2 leading-6 dark:bg-hover" data-ai-result>{result || "（AI 没有返回内容）"}</div>
      <p className="mt-1 text-[11px] text-subtle">AI 生成的内容可能不准确，请核对后使用。</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {canEdit && <button type="button" disabled={!result} onClick={() => { onReplace(result); onClose(); }} className="h-7 rounded-md bg-primary px-2.5 text-[12px] text-white disabled:opacity-40" data-ai-replace>替换原文</button>}
        {canEdit && <button type="button" disabled={!result} onClick={() => { onInsert(result); onClose(); }} className="h-7 rounded-md border px-2.5 text-[12px] hover:bg-hover disabled:opacity-40" data-ai-insert>插入到下方</button>}
        <button type="button" disabled={!result} onClick={() => { void navigator.clipboard?.writeText(result).then(() => setCopied(true)); }} className="flex h-7 items-center gap-1 rounded-md border px-2.5 text-[12px] hover:bg-hover disabled:opacity-40">{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "已复制" : "复制"}</button>
        {last && <button type="button" onClick={() => void run(last.action, last.custom)} className={cn("ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-hover")}><RotateCcw size={12} />重试</button>}
      </div>
    </div>}
  </div>;
}
