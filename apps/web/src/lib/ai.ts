import { ApiError } from "./api";

/** 个人 AI 设置（OpenAI 兼容接口）。API Key 只在保存时上传，服务端加密保存、只返回末 4 位。 */
export interface AISettings { configured: boolean; baseUrl: string; model: string; keyHint?: string; serverReady: boolean }
export interface AIMessage { role: "system" | "user" | "assistant"; content: string }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText);
  return data as T;
}

export const aiApi = {
  settings: () => call<AISettings>("GET", "/api/me/ai"),
  save: (s: { baseUrl: string; model: string; apiKey?: string }) => call<AISettings>("PUT", "/api/me/ai", s),
  clear: () => call<void>("DELETE", "/api/me/ai"),
  test: () => call<{ text: string }>("POST", "/api/me/ai/test"),
  /** 以某篇文档的名义调用（服务端校验可查看且允许复制该文档）。 */
  complete: (docId: number, messages: AIMessage[]) => call<{ text: string }>("POST", `/api/docs/${docId}/ai`, { messages }).then((r) => r.text),
};

/** 与服务端上限一致（字符数）。 */
export const AI_MAX_INPUT = 24000;

export type AIAction = "polish" | "continue" | "summarize" | "shorter" | "longer" | "translate-en" | "translate-zh" | "translate-ja" | "custom";

export const AI_ACTIONS: { id: Exclude<AIAction, "custom">; label: string }[] = [
  { id: "polish", label: "润色" },
  { id: "continue", label: "续写" },
  { id: "summarize", label: "总结" },
  { id: "shorter", label: "精简" },
  { id: "longer", label: "扩写" },
];

export const AI_TRANSLATIONS: { id: AIAction; label: string }[] = [
  { id: "translate-en", label: "英文" },
  { id: "translate-zh", label: "中文" },
  { id: "translate-ja", label: "日文" },
];

const SYSTEM = "你是集成在协同文档中的写作助手。只输出结果正文，不要解释、不要加引号或前后缀，保持原文的语言（翻译任务除外）与 Markdown 风格。";

const INSTRUCTION: Record<Exclude<AIAction, "custom">, string> = {
  polish: "润色下面的内容，使表达更通顺专业，保留原意：",
  continue: "顺着下面的内容自然续写一段（约 100-200 字），只输出续写部分：",
  summarize: "用简洁的要点总结下面的内容：",
  shorter: "在保留关键信息的前提下精简下面的内容：",
  longer: "在不改变原意的前提下扩写下面的内容，补充细节：",
  "translate-en": "把下面的内容翻译成英文：",
  "translate-zh": "把下面的内容翻译成简体中文：",
  "translate-ja": "把下面的内容翻译成日文：",
};

/** Build the chat messages for a block-level action; `context` is optional surrounding text. */
export function blockPrompt(action: AIAction, text: string, custom = "", context = ""): AIMessage[] {
  const instruction = action === "custom" ? `${custom.trim()}\n\n内容：` : INSTRUCTION[action];
  const ctx = context.trim() ? `\n\n（供参考的上下文，不要改写它）\n${context.slice(0, 4000)}` : "";
  return [{ role: "system", content: SYSTEM }, { role: "user", content: `${instruction}\n${text}${ctx}` }];
}

/** 文档问答：把文档正文作为上下文（超出部分截断并告知模型）。 */
export function docPrompt(title: string, body: string, history: AIMessage[], question: string): AIMessage[] {
  const budget = AI_MAX_INPUT - 2000 - question.length - history.reduce((n, m) => n + m.content.length, 0);
  const clipped = body.length > budget ? `${body.slice(0, Math.max(0, budget))}\n…（正文过长，已截断）` : body;
  return [
    { role: "system", content: `你是文档「${title || "未命名文档"}」的助手。依据下面的文档内容回答用户问题；文档中没有的信息要明确说明。回答使用用户提问的语言，可使用 Markdown。\n\n文档内容：\n${clipped}` },
    ...history.slice(-8),
    { role: "user", content: question },
  ];
}

/** 用户可读的错误说明。 */
export function aiErrorText(err: unknown): string {
  if (err instanceof ApiError) return err.message || "AI 请求失败";
  return "AI 请求失败，请检查网络后重试";
}

export const AI_SETTINGS_EVENT = "jiange:open-ai-settings";
export function openAISettings() { window.dispatchEvent(new Event(AI_SETTINGS_EVENT)); }
