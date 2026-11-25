import { useEffect, useRef, useState } from "react";
import { Copy, CornerDownLeft, Loader2, Plus, Settings, Sparkles, Square, Trash2, X } from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  aiErrorText,
  docPrompt,
  isAbortError,
  openAISettings,
  runDocAIStream,
  withDocAIStreamContext,
  type AIMessage,
  type DocAIStreamCallbacks,
  type DocAIStreamDonePayload,
} from "@/lib/ai";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** 文档 AI 侧栏（对应飞书顶栏「问问豆包」）：基于当前文档内容流式问答，可随时停止并将回答插入文末。 */
export function DocAIPanel({ title, body, ai, docId, aiStream, canInsert, onInsert, onClose }: {
  title: string;
  /** Returns the current document as Markdown (read at send time). */
  body: () => string;
  ai: (messages: AIMessage[]) => Promise<string>;
  docId?: number;
  aiStream?: (messages: AIMessage[], callbacks: DocAIStreamCallbacks, signal?: AbortSignal) => Promise<DocAIStreamDonePayload>;
  canInsert: boolean;
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const quickPrompts = [t("总结这篇文档"), t("提炼文中的待办事项"), t("生成文档大纲"), t("检查错别字和病句")];
  const [history, setHistory] = useState<AIMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; settings: boolean } | null>(null);
  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<{ prior: AIMessage[]; question: string; streamed: string } | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [history, streamingText, busy]);
  useEffect(() => () => {
    seq.current++;
    abortRef.current?.abort();
  }, []);

  const stop = () => {
    seq.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) {
      if (pending.streamed.trim()) {
        setHistory([...pending.prior, { role: "user", content: pending.question }, { role: "assistant", content: pending.streamed }]);
      } else {
        setHistory(pending.prior);
        setInput(pending.question);
      }
    }
    setStreamingText("");
    setBusy(false);
  };

  const send = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const id = ++seq.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setInput("");
    setStreamingText("");
    const prior = history;
    pendingRef.current = { prior, question: q, streamed: "" };
    setHistory([...prior, { role: "user", content: q }]);

    const messages = docPrompt(title, body(), prior, q);
    const callbacks: DocAIStreamCallbacks = {
      onDelta: (chunk) => {
        if (id !== seq.current || !chunk) return;
        if (pendingRef.current) {
          pendingRef.current.streamed += chunk;
          setStreamingText(pendingRef.current.streamed);
        }
      },
    };

    try {
      let answer: string;
      if (aiStream) {
        const done = await aiStream(messages, callbacks, controller.signal);
        answer = done.text;
      } else if (typeof docId === "number" && docId > 0) {
        const done = await runDocAIStream({ docId, messages }, callbacks, controller.signal);
        answer = done.text;
      } else {
        answer = await withDocAIStreamContext(callbacks, controller.signal, () => ai(messages));
      }
      if (id === seq.current) {
        const finalAnswer = answer || pendingRef.current?.streamed || "";
        pendingRef.current = null;
        setStreamingText("");
        setHistory([...prior, { role: "user", content: q }, { role: "assistant", content: finalAnswer }]);
      }
    } catch (err) {
      if (id === seq.current) {
        const partial = pendingRef.current?.streamed ?? "";
        pendingRef.current = null;
        setStreamingText("");
        if (controller.signal.aborted || isAbortError(err)) {
          if (partial.trim()) {
            setHistory([...prior, { role: "user", content: q }, { role: "assistant", content: partial }]);
          } else {
            setHistory(prior);
            setInput(q);
          }
        } else {
          if (partial.trim()) {
            setHistory([...prior, { role: "user", content: q }, { role: "assistant", content: partial }]);
          } else {
            setHistory(prior);
            setInput(q);
          }
          setError({
            text: aiErrorText(err),
            settings: err instanceof ApiError && (err.code === "ai_not_configured" || err.code.startsWith("ai_key") || err.code === "ai_auth_failed" || err.code === "invalid_base_url"),
          });
        }
      }
    } finally {
      if (id === seq.current) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  };

  return <aside className="fixed bottom-0 right-0 top-14 z-30 flex w-full flex-col border-l bg-surface shadow-xl sm:w-[358px] md:top-16 xl:shadow-none" aria-label={t("AI 助手")} data-doc-ai-panel>
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b px-4 text-[14px] font-medium">
      <Sparkles size={16} className="text-primary" />{t("AI 助手")}
      <button type="button" title={t("清空对话")} aria-label={t("清空对话")} disabled={!history.length || busy} onClick={() => { setHistory([]); setStreamingText(""); setError(null); }} className="ml-auto grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover disabled:opacity-30"><Trash2 size={14} /></button>
      <button type="button" title={t("AI 设置")} aria-label={t("AI 设置")} onClick={() => openAISettings()} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover"><Settings size={14} /></button>
      <button type="button" aria-label={t("关闭")} onClick={() => { stop(); onClose(); }} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover"><X size={16} /></button>
    </header>
    <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-[13px]">
      {!history.length && <div className="flex min-h-full flex-col items-center justify-center gap-4 pb-10 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-[#4E83FD] to-[#7B61FF] text-white"><Sparkles size={24} /></span>
        <p className="text-[20px] font-semibold text-foreground">{t("今天有什么工作要处理？")}</p>
        <p className="text-[12px] text-subtle">{t("基于当前文档内容回答，由你在 AI 设置中配置的模型生成，可能不准确。")}</p>
        <div className="flex flex-wrap justify-center gap-1.5">{quickPrompts.map((q) => <button key={q} type="button" disabled={busy} onClick={() => void send(q)} className="h-7 rounded-full border px-2.5 text-[12px] hover:border-primary hover:text-primary disabled:opacity-40" data-ai-quick>{q}</button>)}</div>
      </div>}
      {history.map((m, i) => <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
        <div className={cn("max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 leading-6", m.role === "user" ? "bg-[#e1eaff] text-foreground dark:bg-primary/20" : "bg-[#F5F6F7] dark:bg-hover")} data-ai-message={m.role}>
          {m.content}
          {m.role === "assistant" && <div className="mt-1.5 flex gap-1 text-[12px]">
            {canInsert && <button type="button" onClick={() => onInsert(m.content)} className="flex h-6 items-center gap-1 rounded px-1.5 text-primary hover:bg-black/5"><Plus size={12} />{t("插入文末")}</button>}
            <button type="button" onClick={() => void navigator.clipboard?.writeText(m.content)} className="flex h-6 items-center gap-1 rounded px-1.5 text-muted-foreground hover:bg-black/5"><Copy size={12} />{t("复制")}</button>
          </div>}
        </div>
      </div>)}
      {busy && streamingText && (
        <div className="flex justify-start">
          <div className="max-w-[92%] whitespace-pre-wrap break-words rounded-lg bg-[#F5F6F7] px-3 py-2 leading-6 dark:bg-hover" data-ai-message="assistant" data-ai-streaming="true">
            {streamingText}
            <span aria-hidden="true" className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse align-text-bottom bg-primary" />
          </div>
        </div>
      )}
      {busy && (
        <div role="status" className="flex items-center justify-between gap-2 text-subtle">
          <span className="flex items-center gap-1.5">
            <Loader2 size={14} className="animate-spin" />
            {streamingText ? t("AI 正在生成…") : t("AI 正在思考…")}
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
      {error && <p role="alert" className="text-destructive">{error.text}{error.settings && <button type="button" onClick={() => openAISettings()} className="ml-2 text-primary underline">{t("去设置")}</button>}</p>}
    </div>
    <form className="m-3 flex items-end gap-2 rounded-2xl border px-3 py-2.5 shadow-[0_2px_10px_rgba(31,35,41,0.06)] focus-within:border-primary" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
      <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }} rows={2} maxLength={2000} placeholder={t("发消息或描述任务，Enter 发送")} className="max-h-32 min-h-10 flex-1 resize-none bg-transparent text-[13px] outline-none" data-ai-input />
      {busy ? (
        <button type="button" onClick={stop} aria-label={t("停止生成")} title={t("停止生成")} className="grid size-7 place-items-center rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10"><Square size={12} className="fill-current" /></button>
      ) : (
        <button type="submit" disabled={!input.trim()} aria-label={t("发送")} className="grid size-7 place-items-center rounded-md bg-primary text-white disabled:opacity-30"><CornerDownLeft size={14} /></button>
      )}
    </form>
  </aside>;
}
