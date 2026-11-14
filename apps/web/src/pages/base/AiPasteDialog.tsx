import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";
import { ApiError, baseApi, type Cell, type Field } from "@/lib/api";
import { aiApi, aiErrorText } from "@/lib/ai";
import { AISettingsDialog } from "@/components/AISettings";
import { useI18n } from "@/lib/i18n";
import { AI_PASTE_LIMIT, aiPasteFields, aiPastePrompt, parseAiPaste } from "./aiPaste";
import { REGISTRY } from "./registry";
import { refreshWrites, useWriteLedger } from "./writeSafety";

export function AiPasteDialog({ baseId, userId, fields, allowed, onClose, onRefresh }: { baseId: number; userId: number; fields: Field[]; allowed: boolean; onClose: () => void; onRefresh: () => Promise<unknown> }) {
  const { t } = useI18n();
  const { ledger } = useWriteLedger(baseId);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{ rows: Record<string, Cell>[]; schema: string } | null>(null);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), mounted = useRef(true), controller = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const schema = useMemo(() => aiPasteFields(fields), [fields]);
  const schemaKey = JSON.stringify(schema);
  const latest = useRef({ allowed, schemaKey }); latest.current = { allowed, schemaKey };
  useEffect(() => { mounted.current = true; input.current?.focus(); return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  const close = () => { if (!pending.current) onClose(); };
  const recognize = async () => {
    if (!allowed || pending.current || !text.trim() || text.length > AI_PASTE_LIMIT || !schema.length) return;
    const messages = aiPastePrompt(text, schema);
    if (messages.reduce((n, m) => n + Array.from(m.content).length, 0) > 24000) { setError(t("字段配置过长，无法发送给 AI。")); return; }
    pending.current = true; setBusy(true); setError(""); setSettings(false); setPreview(null);
    const abort = new AbortController(); controller.current = abort;
    try {
      const answer = await aiApi.completeForAccount(baseId, userId, messages, abort.signal);
      if (!mounted.current || !latest.current.allowed || latest.current.schemaKey !== schemaKey) return;
      const rows = parseAiPaste(answer, schema);
      if (!rows) { setError(t("AI 返回的数据无法匹配当前字段，请检查内容后重试。")); return; }
      setPreview({ rows, schema: schemaKey });
    } catch (e) {
      if (mounted.current && !abort.signal.aborted) { setError(aiErrorText(e)); setSettings(e instanceof ApiError && ["ai_not_configured", "ai_key_unreadable", "ai_auth_failed", "invalid_base_url"].includes(e.code)); }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const commit = async () => {
    if (!allowed || !preview || preview.schema !== schemaKey || pending.current || ledger.blocked("batch") || ledger.blocked("record:create") || ledger.hasCellWrites()) return;
    const draft = JSON.stringify({ text, rows: preview.rows });
    const op = ledger.begin(t("AI 粘贴录入"), draft, "batch", undefined, false, true, { kind: "paste", recordIds: [], fieldIds: schema.map((field) => field.id) });
    if (op === null) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await baseApi.importRecordsForAccount(baseId, userId, schema, preview.rows);
      if (!result || result.imported !== preview.rows.length) throw new Error("Unexpected import response");
      ledger.complete(op); refreshWrites(onRefresh); if (mounted.current) onClose();
    } catch (e) {
      const known = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
      if (known) ledger.complete(op); else ledger.fail(op, t("无法确认录入是否完成，请先核对记录，勿直接重复录入。"));
      if (mounted.current) setError(known ? e instanceof ApiError && [404, 405].includes(e.status) ? t("服务端不支持 AI 录入，请升级后重试。") : e.message : t("无法确认录入是否完成，请先核对记录，勿直接重复录入。"));
      refreshWrites(onRefresh);
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const visible = allowed;
  return createPortal(<div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-label={t("AI 粘贴录入")} className="flex max-h-[calc(100dvh-32px)] w-full max-w-[572px] flex-col rounded-lg bg-surface p-6 text-foreground shadow-2xl" onKeyDown={(event) => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); close(); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const controls = [...dialog.current.querySelectorAll<HTMLElement>('textarea:not(:disabled),button:not(:disabled)')];
      if (!controls.length) return;
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
    }}>
      <header className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">{t("AI 粘贴录入")}</h2><button type="button" aria-label={t("关闭")} disabled={busy} onClick={close} className="grid size-7 place-items-center rounded text-subtle hover:bg-hover disabled:opacity-50"><X size={18}/></button></header>
      {!visible ? <p role="status" className="py-8 text-sm text-subtle">{t("正在核对表格权限，内容暂时隐藏。")}</p> : <>
        <p className="mt-1 text-[13px] text-subtle">{t("粘贴文本，AI 将识别记录并在录入前供你核对。图片暂不支持。")}</p>
        <p className="mt-1 text-[12px] text-subtle">{t("识别时会将文本和字段信息发送至你配置的 AI 服务。")}</p>
        {!preview ? <textarea ref={input} value={text} onChange={(event) => { setText(event.target.value); setError(""); }} maxLength={AI_PASTE_LIMIT} disabled={busy} placeholder={t("在此粘贴或输入文本，最多 10,000 字")}
          onPaste={(event) => { if ([...event.clipboardData.items].some((item) => item.type.startsWith("image/"))) { event.preventDefault(); setError(t("图片识别暂不支持，请先粘贴文本。")); } }}
          onDrop={(event) => { if ([...event.dataTransfer.files].some((file) => file.type.startsWith("image/"))) { event.preventDefault(); setError(t("图片识别暂不支持，请先粘贴文本。")); } }}
          className="mt-6 min-h-[220px] w-full resize-y rounded-lg border border-dashed border-[#dee0e3] bg-[#f7f8fa] p-4 text-sm outline-none focus:border-primary dark:bg-sidebar"/> : <div className="mt-5 min-h-0 overflow-auto rounded-md border" data-ai-paste-preview>
            <table className="w-full min-w-max text-left text-[13px]"><thead className="bg-[#f7f8fa] dark:bg-sidebar"><tr>{schema.map((field) => <th key={field.id} className="border-b px-3 py-2 font-medium">{field.name}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}>{schema.map((field) => <td key={field.id} className="max-w-48 whitespace-pre-wrap break-words border-b px-3 py-2">{REGISTRY[field.type].format(row[field.id], field as Field)}</td>)}</tr>)}</tbody></table>
          </div>}
        {preview && preview.schema !== schemaKey && <p role="alert" className="mt-2 text-xs text-destructive">{t("字段已变化，请重新识别。")}</p>}
        {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}{settings && <button type="button" onClick={() => setSettingsOpen(true)} className="ml-2 underline">{t("AI 设置")}</button>}</p>}
        <footer className="mt-5 flex items-center justify-end gap-2">
          {preview && <button type="button" disabled={busy} onClick={() => { setPreview(null); setError(""); }} className="h-8 rounded border px-3 text-[13px] hover:bg-hover">{t("返回修改")}</button>}
          <button type="button" disabled={busy || (!preview && (!text.trim() || !schema.length)) || (!!preview && (preview.schema !== schemaKey || ledger.blocked("batch") || ledger.blocked("record:create") || ledger.hasCellWrites()))} onClick={() => void (preview ? commit() : recognize())} className="flex h-8 items-center gap-1 rounded bg-primary px-3 text-[13px] text-white hover:bg-primary-hover disabled:opacity-40"><Sparkles size={14}/>{busy ? t("处理中…") : preview ? t("录入 {n} 条记录", { n: preview.rows.length }) : t("识别并预览")}</button>
        </footer>
      </>}
      {settingsOpen && <div className="fixed inset-0 z-[130]" onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setSettingsOpen(false); }
        else if (event.key === "Tab") {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')];
          if (controls.length && event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
          else if (controls.length && !event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
          event.stopPropagation();
        }
      }}><AISettingsDialog onClose={() => setSettingsOpen(false)} /></div>}
    </section>
  </div>, document.body);
}
