import { useEffect, useRef, useState } from "react";
import { Copy, CornerDownLeft, Loader2, Plus, Settings, Sparkles, Trash2, X } from "lucide-react";
import { ApiError } from "@/lib/api";
import { aiErrorText, docPrompt, openAISettings, type AIMessage } from "@/lib/ai";
import { cn } from "@/lib/utils";

const QUICK = ["总结这篇文档", "提炼文中的待办事项", "生成文档大纲", "检查错别字和病句"];

/** 文档 AI 侧栏（对应飞书顶栏「问问豆包」）：基于当前文档内容问答，可把回答插入文末。 */
export function DocAIPanel({ title, body, ai, canInsert, onInsert, onClose }: {
  title: string;
  /** Returns the current document as Markdown (read at send time). */
  body: () => string;
  ai: (messages: AIMessage[]) => Promise<string>;
  canInsert: boolean;
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<AIMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; settings: boolean } | null>(null);
  const seq = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [history, busy]);
  useEffect(() => () => { seq.current++; }, []);
  const send = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const id = ++seq.current;
    setBusy(true); setError(null); setInput("");
    const prior = history;
    setHistory([...prior, { role: "user", content: q }]);
    try {
      const answer = await ai(docPrompt(title, body(), prior, q));
      if (id === seq.current) setHistory([...prior, { role: "user", content: q }, { role: "assistant", content: answer }]);
    } catch (err) {
      if (id === seq.current) {
        setHistory(prior); setInput(q);
        setError({ text: aiErrorText(err), settings: err instanceof ApiError && (err.code === "ai_not_configured" || err.code.startsWith("ai_key") || err.code === "ai_auth_failed" || err.code === "invalid_base_url") });
      }
    } finally { if (id === seq.current) setBusy(false); }
  };
  return <aside className="fixed bottom-0 right-0 top-16 z-30 flex w-full flex-col border-l bg-surface shadow-xl sm:w-96 xl:shadow-none" aria-label="AI 助手" data-doc-ai-panel>
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b px-4 text-[14px] font-medium">
      <Sparkles size={16} className="text-primary" />AI 助手
      <button type="button" title="清空对话" aria-label="清空对话" disabled={!history.length || busy} onClick={() => { setHistory([]); setError(null); }} className="ml-auto grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover disabled:opacity-30"><Trash2 size={14} /></button>
      <button type="button" title="AI 设置" aria-label="AI 设置" onClick={() => openAISettings()} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover"><Settings size={14} /></button>
      <button type="button" aria-label="关闭" onClick={onClose} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover"><X size={16} /></button>
    </header>
    <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-[13px]">
      {!history.length && <div className="space-y-2">
        <p className="text-subtle">基于当前文档内容提问，回答由你配置的模型生成，可能不准确。</p>
        <div className="flex flex-wrap gap-1.5">{QUICK.map((q) => <button key={q} type="button" disabled={busy} onClick={() => void send(q)} className="h-7 rounded-full border px-2.5 text-[12px] hover:border-primary hover:text-primary disabled:opacity-40" data-ai-quick>{q}</button>)}</div>
      </div>}
      {history.map((m, i) => <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
        <div className={cn("max-w-[92%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 leading-6", m.role === "user" ? "bg-[#e1eaff] text-foreground" : "bg-[#F5F6F7] dark:bg-hover")} data-ai-message={m.role}>
          {m.content}
          {m.role === "assistant" && <div className="mt-1.5 flex gap-1 text-[12px]">
            {canInsert && <button type="button" onClick={() => onInsert(m.content)} className="flex h-6 items-center gap-1 rounded px-1.5 text-primary hover:bg-black/5"><Plus size={12} />插入文末</button>}
            <button type="button" onClick={() => void navigator.clipboard?.writeText(m.content)} className="flex h-6 items-center gap-1 rounded px-1.5 text-muted-foreground hover:bg-black/5"><Copy size={12} />复制</button>
          </div>}
        </div>
      </div>)}
      {busy && <p role="status" className="flex items-center gap-1.5 text-subtle"><Loader2 size={14} className="animate-spin" />AI 正在思考…</p>}
      {error && <p role="alert" className="text-destructive">{error.text}{error.settings && <button type="button" onClick={() => openAISettings()} className="ml-2 text-primary underline">去设置</button>}</p>}
    </div>
    <form className="m-3 flex items-end gap-2 rounded-lg border px-3 py-2 focus-within:border-primary" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
      <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }} rows={2} maxLength={2000} placeholder="向 AI 提问，Enter 发送" className="max-h-32 min-h-10 flex-1 resize-none bg-transparent text-[13px] outline-none" data-ai-input />
      <button type="submit" disabled={busy || !input.trim()} aria-label="发送" className="grid size-7 place-items-center rounded-md bg-primary text-white disabled:opacity-30"><CornerDownLeft size={14} /></button>
    </form>
  </aside>;
}
