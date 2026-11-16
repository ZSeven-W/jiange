import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";
import { aiApi, aiErrorText, AI_SETTINGS_EVENT, type AIProvider } from "@/lib/ai";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** 挂在应用根部：响应 openAISettings() 打开「AI 设置」对话框。 */
export function AISettingsHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(AI_SETTINGS_EVENT, show);
    return () => window.removeEventListener(AI_SETTINGS_EVENT, show);
  }, []);
  return open ? <AISettingsDialog onClose={() => setOpen(false)} /> : null;
}

const PRESETS: [string, AIProvider, string, string][] = [
  ["Anthropic", "anthropic", "https://api.anthropic.com/v1", "claude-sonnet-4-5"],
  ["OpenAI", "openai", "https://api.openai.com/v1", "gpt-4o-mini"],
  ["DeepSeek", "openai", "https://api.deepseek.com/v1", "deepseek-chat"],
  ["Moonshot", "openai", "https://api.moonshot.cn/v1", "moonshot-v1-8k"],
  ["通义千问", "openai", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"],
  ["OpenRouter", "openai", "https://openrouter.ai/api/v1", "openai/gpt-4o-mini"],
];

export function AISettingsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["ai-settings"], queryFn: aiApi.settings });
  const [provider, setProvider] = useState<AIProvider>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test" | "clear">("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (q.data) { setProvider(q.data.provider ?? "openai"); setBaseUrl(q.data.baseUrl); setModel(q.data.model); } }, [q.data]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const run = async (kind: "save" | "test" | "clear") => {
    setBusy(kind); setMessage(null);
    try {
      if (kind === "save") { const next = await aiApi.save({ provider, baseUrl, model, apiKey: apiKey || undefined }); qc.setQueryData(["ai-settings"], next); setApiKey(""); setMessage({ ok: true, text: t("已保存") }); }
      if (kind === "test") { const r = await aiApi.test(); setMessage({ ok: true, text: t("连接成功：{text}", { text: r.text.slice(0, 40) }) }); }
      if (kind === "clear") { await aiApi.clear(); await q.refetch(); setApiKey(""); setMessage({ ok: true, text: t("已清除 AI 设置") }); }
    } catch (err) { setMessage({ ok: false, text: aiErrorText(err) }); }
    finally { setBusy(""); }
  };
  const field = "mt-1 h-9 w-full rounded-md border bg-surface px-2.5 text-[13px] outline-none focus:border-primary";
  return <div className="fixed inset-0 z-[70] grid place-items-center bg-black/30 px-4" onMouseDown={onClose}>
    <div role="dialog" aria-modal="true" aria-label={t("AI 设置")} className="w-full max-w-[460px] rounded-lg bg-surface p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()} data-ai-settings>
      <div className="flex items-center gap-2"><Sparkles size={18} className="text-primary" /><h2 className="text-[16px] font-semibold">{t("AI 设置")}</h2><button type="button" aria-label={t("关闭")} onClick={onClose} className="ml-auto grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover"><X size={16} /></button></div>
      <p className="mt-2 text-[12px] leading-5 text-subtle">{t("使用你自己的 OpenAI 兼容或 Anthropic 接口。API Key 加密保存在服务器，仅你本人的请求会使用；受复制保护的文档内容不会发送给 AI。")}</p>
      {q.data && !q.data.serverReady && <p role="alert" className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-900">{t("服务器未配置 JIANGE_SECRET_KEY，暂时无法保存 API Key，请联系管理员。")}</p>}
      {q.isError && <p role="alert" className="mt-3 text-[12px] text-destructive">{t("无法加载 AI 设置。")}</p>}
      <div className="mt-4 flex flex-wrap gap-1.5">{PRESETS.map(([name, p, url, m]) => <button key={name} type="button" onClick={() => { setProvider(p); setBaseUrl(url); setModel(m); }} className={cn("h-7 rounded-full border px-2.5 text-[12px] hover:border-primary hover:text-primary", baseUrl === url ? "border-primary text-primary" : "text-muted-foreground")}>{name}</button>)}</div>
      <div className="mt-3 text-[13px]">{t("接口协议")}
        <div className="mt-1 flex rounded-md bg-hover p-0.5 text-[12px]" role="radiogroup" aria-label={t("接口协议")}>
          {([["openai", t("OpenAI 兼容")], ["anthropic", "Anthropic"]] as const).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={provider === value} onClick={() => setProvider(value)} className={cn("h-7 flex-1 rounded", provider === value ? "bg-surface font-medium text-primary shadow-sm" : "text-muted-foreground")} data-ai-provider={value}>{label}</button>)}
        </div>
      </div>
      <label className="mt-3 block text-[13px]">{t("接口地址")}<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"} className={field} data-ai-base-url /></label>
      <label className="mt-3 block text-[13px]">{t("模型")}<input value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o-mini"} className={field} data-ai-model /></label>
      <label className="mt-3 block text-[13px]">API Key<input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={q.data?.configured ? t("已保存（末四位 {hint}），留空则不修改", { hint: q.data.keyHint ?? "" }) : "sk-…"} className={field} data-ai-key /></label>
      {message && <p role={message.ok ? "status" : "alert"} className={message.ok ? "mt-3 text-[12px] text-[#00a13b]" : "mt-3 text-[12px] text-destructive"}>{message.text}</p>}
      <div className="mt-5 flex items-center gap-2">
        {q.data?.configured && <button type="button" disabled={!!busy} onClick={() => void run("clear")} className="h-8 rounded-md px-2 text-[13px] text-destructive hover:bg-[#fff2f0] disabled:opacity-40">{t("清除")}</button>}
        <span className="ml-auto" />
        <button type="button" disabled={!!busy || !q.data?.configured} onClick={() => void run("test")} className="h-8 rounded-md border px-3 text-[13px] hover:bg-hover disabled:opacity-40">{busy === "test" ? t("测试中…") : t("测试连接")}</button>
        <button type="button" disabled={!!busy || !q.data?.serverReady || (!apiKey && !q.data?.configured)} onClick={() => void run("save")} className="h-8 rounded-md bg-primary px-3 text-[13px] text-white disabled:opacity-40" data-ai-save>{busy === "save" ? t("保存中…") : t("保存")}</button>
      </div>
    </div>
  </div>;
}
