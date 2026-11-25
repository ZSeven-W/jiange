import { useEffect, useRef, useState } from "react";
import { Check, Copy, CornerDownLeft, Languages, Loader2, RotateCcw, Settings, Sparkles, Square, X } from "lucide-react";
import {
  AI_ACTIONS,
  AI_TRANSLATIONS,
  aiErrorText,
  blockPrompt,
  isAbortError,
  openAISettings,
  runDocAIStream,
  withDocAIStreamContext,
  type AIAction,
  type AIMessage,
  type DocAIStreamCallbacks,
  type DocAIStreamDonePayload,
} from "@/lib/ai";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 块级 AI 面板（对应飞书块菜单「问问豆包」与「翻译」）：
 * 预设动作 / 自定义指令 → 流式结果预览（可随时停止） → 替换原文 / 插入到下方 / 复制。结果只在用户确认后写入文档。
 */
export function AIBlockPanel({ x, y, text, context, initial, ai, docId, aiStream, canEdit, onReplace, onInsert, onClose }: {
  x: number; y: number;
  text: string;
  context?: string;
  initial?: AIAction;
  ai: (messages: AIMessage[]) => Promise<string>;
  docId?: number;
  aiStream?: (messages: AIMessage[], callbacks: DocAIStreamCallbacks, signal?: AbortSignal) => Promise<DocAIStreamDonePayload>;
  canEdit: boolean;
  onReplace: (result: string) => void;
  onInsert: (result: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; settings: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [last, setLast] = useState<{ action: AIAction; custom: string } | null>(null);
  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (previewRef.current) {
      previewRef.current.scrollTop = previewRef.current.scrollHeight;
    }
  }, [result]);

  useEffect(() => () => {
    seq.current++;
    abortRef.current?.abort();
  }, []);

  const stop = () => {
    seq.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  };

  const run = async (action: AIAction, instruction = "") => {
    if (!text.trim() && action !== "custom") { setError({ text: t("当前块没有可处理的文字。"), settings: false }); return; }
    abortRef.current?.abort();
    const id = ++seq.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setResult(null);
    setCopied(false);
    setLast({ action, custom: instruction });

    let streamed = "";
    const messages = blockPrompt(action, text, instruction, context);
    const callbacks: DocAIStreamCallbacks = {
      onDelta: (chunk) => {
        if (id !== seq.current || !chunk) return;
        streamed += chunk;
        setResult(streamed);
      },
    };

    try {
      let out: string;
      if (aiStream) {
        const done = await aiStream(messages, callbacks, controller.signal);
        out = done.text;
      } else if (typeof docId === "number" && docId > 0) {
        const done = await runDocAIStream({ docId, messages }, callbacks, controller.signal);
        out = done.text;
      } else {
        out = await withDocAIStreamContext(callbacks, controller.signal, () => ai(messages));
      }
      if (id === seq.current) setResult(out || streamed);
    } catch (err) {
      if (id === seq.current && !controller.signal.aborted && !isAbortError(err)) {
        setError({
          text: t(aiErrorText(err)),
          settings: err instanceof ApiError && (err.code === "ai_not_configured" || err.code.startsWith("ai_key") || err.code === "ai_auth_failed" || err.code === "invalid_base_url"),
        });
      }
    } finally {
      if (id === seq.current) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  };

  useEffect(() => { if (initial) void run(initial); /* run once for 翻译 shortcuts */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { seq.current++; abortRef.current?.abort(); onClose(); } };
    const onDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) { seq.current++; abortRef.current?.abort(); onClose(); } };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [onClose]);

  const chip = "flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] text-foreground hover:border-primary hover:text-primary disabled:opacity-40";
  return <div ref={root} contentEditable={false} className="absolute z-50 w-[min(420px,calc(100vw-24px))] rounded-lg border border-[#D9DBDF] bg-surface p-3 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.16)] dark:border-border" style={{ left: x, top: y }} onMouseDown={(e) => { if (!(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) e.preventDefault(); }} data-ai-block-panel>
    <div className="flex items-center gap-1.5 font-medium"><Sparkles size={15} className="text-primary" />AI<button type="button" aria-label={t("AI 设置")} title={t("AI 设置")} onClick={() => openAISettings()} className="ml-auto grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover"><Settings size={14} /></button><button type="button" aria-label={t("关闭")} onClick={() => { stop(); onClose(); }} className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover"><X size={14} /></button></div>
    <div className="mt-2 flex flex-wrap gap-1.5">
      {AI_ACTIONS.map((a) => <button key={a.id} type="button" disabled={busy} onClick={() => void run(a.id)} className={chip} data-ai-action={a.id}>{t(a.label)}</button>)}
      {AI_TRANSLATIONS.map((a) => <button key={a.id} type="button" disabled={busy} onClick={() => void run(a.id)} className={chip} data-ai-action={a.id}><Languages size={12} />{t("译为{lang}", { lang: t(a.label) })}</button>)}
    </div>
    <form className="mt-2 flex items-center gap-1.5 rounded-md border px-2 focus-within:border-primary" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) void run("custom", custom); }}>
      <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t("告诉 AI 要怎么处理这段内容…")} maxLength={500} className="h-8 min-w-0 flex-1 bg-transparent outline-none" data-ai-custom />
      <button type="submit" disabled={busy || !custom.trim()} aria-label={t("发送")} className="grid size-6 place-items-center rounded text-primary disabled:opacity-30"><CornerDownLeft size={14} /></button>
    </form>
    {busy && (
      <div role="status" className="mt-3 flex items-center justify-between gap-2 text-subtle">
        <span className="flex items-center gap-1.5">
          <Loader2 size={14} className="animate-spin" />
          {t("AI 正在生成…")}
        </span>
        <button
          type="button"
          onClick={stop}
          data-ai-stop
          className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[12px] text-foreground hover:bg-hover"
        >
          <Square size={10} className="fill-current" />
          {t("停止生成")}
        </button>
      </div>
    )}
    {error && <div role="alert" className="mt-3 text-destructive">{error.text}{error.settings && <button type="button" onClick={() => openAISettings()} className="ml-2 text-primary underline">{t("去设置")}</button>}</div>}
    {result !== null && <div className="mt-3">
      <div ref={previewRef} className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-[#F5F6F7] px-3 py-2 leading-6 dark:bg-hover" data-ai-result data-ai-streaming={busy ? "true" : undefined}>
        {result || (busy ? "" : t("（AI 没有返回内容）"))}
        {busy && <span aria-hidden="true" className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse align-text-bottom bg-primary" />}
      </div>
      <p className="mt-1 text-[11px] text-subtle">{t("AI 生成的内容可能不准确，请核对后使用。")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {canEdit && <button type="button" disabled={busy || !result} onClick={() => { onReplace(result); onClose(); }} className="h-7 rounded-md bg-primary px-2.5 text-[12px] text-white disabled:opacity-40" data-ai-replace>{t("替换原文")}</button>}
        {canEdit && <button type="button" disabled={busy || !result} onClick={() => { onInsert(result); onClose(); }} className="h-7 rounded-md border px-2.5 text-[12px] hover:bg-hover disabled:opacity-40" data-ai-insert>{t("插入到下方")}</button>}
        <button type="button" disabled={busy || !result} onClick={() => { void navigator.clipboard?.writeText(result).then(() => setCopied(true)); }} className="flex h-7 items-center gap-1 rounded-md border px-2.5 text-[12px] hover:bg-hover disabled:opacity-40">{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? t("已复制") : t("复制")}</button>
        {last && <button type="button" disabled={busy} onClick={() => void run(last.action, last.custom)} className={cn("ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-hover disabled:opacity-40")}><RotateCcw size={12} />{t("重试")}</button>}
      </div>
    </div>}
  </div>;
}
