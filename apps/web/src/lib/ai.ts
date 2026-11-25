import { ApiError } from "./api";

/** 个人 AI 设置（OpenAI 兼容接口或 Anthropic Messages API）。API Key 只在保存时上传，服务端加密保存、只返回末 4 位。 */
export type AIProvider = "openai" | "anthropic";
export interface AISettings { configured: boolean; provider: AIProvider; baseUrl: string; model: string; keyHint?: string; serverReady: boolean }
export interface AIMessage { role: "system" | "user" | "assistant"; content: string }

export interface DocAIStreamRequest {
  docId?: number;
  messages: AIMessage[];
}

export interface DocAIStreamDonePayload {
  text: string;
  provider?: string;
  model?: string;
}

export interface DocAIStreamCallbacks {
  onDelta?: (text: string) => void;
  onDone?: (payload: DocAIStreamDonePayload) => void;
  onError?: (error: Error) => void;
}

interface ActiveDocAIStreamContext {
  callbacks: DocAIStreamCallbacks;
  signal?: AbortSignal;
}

let activeStreamContext: ActiveDocAIStreamContext | null = null;

/**
 * Attach streaming callbacks and an AbortSignal synchronously around an `ai(messages)`
 * invocation so callers passing `(messages) => aiApi.complete(docId, messages)`
 * automatically upgrade to `POST /api/ai/doc/stream` SSE streaming without changing
 * parent prop signatures, while custom/mock `ai` functions keep working unchanged.
 */
export function withDocAIStreamContext<T>(
  callbacks: DocAIStreamCallbacks,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = activeStreamContext;
  activeStreamContext = { callbacks, signal };
  try {
    return fn();
  } finally {
    activeStreamContext = prev;
  }
}

export function isAbortError(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") {
    return true;
  }
  return err instanceof Error && err.name === "AbortError";
}

function parseDocAISseBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    if (colon < 0) continue;
    const field = rawLine.slice(0, colon).trim();
    let value = rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      event = value.trim() || "message";
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

async function fallbackDocAI(
  req: DocAIStreamRequest,
  callbacks: DocAIStreamCallbacks,
  signal?: AbortSignal,
): Promise<DocAIStreamDonePayload> {
  const hasDocId = typeof req.docId === "number" && Number.isSafeInteger(req.docId) && req.docId > 0;
  const path = hasDocId ? `/api/docs/${req.docId}/ai` : "/api/ai/doc";
  const payload = hasDocId ? { messages: req.messages } : req;
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof data.error === "string" ? data.error : typeof data.code === "string" ? data.code : "error",
      typeof data.message === "string" ? data.message : res.statusText,
      data,
    );
  }
  const done: DocAIStreamDonePayload = {
    text: typeof data.text === "string" ? data.text : "",
    provider: typeof data.provider === "string" ? data.provider : undefined,
    model: typeof data.model === "string" ? data.model : undefined,
  };
  if (done.text) callbacks.onDelta?.(done.text);
  callbacks.onDone?.(done);
  return done;
}

/**
 * Stream a single-document AI completion over SSE (`POST /api/ai/doc/stream`),
 * invoking `onDelta` progressively as tokens arrive. Gracefully falls back to
 * non-streaming JSON if the server returns 404/405/501, JSON content-type, or
 * a non-streaming response body.
 */
export async function runDocAIStream(
  req: DocAIStreamRequest,
  callbacks: DocAIStreamCallbacks = {},
  signal?: AbortSignal,
): Promise<DocAIStreamDonePayload> {
  try {
    const res = await fetch("/api/ai/doc/stream", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(req),
      signal,
    });

    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return await fallbackDocAI(req, callbacks, signal);
    }

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ApiError(
        res.status,
        typeof errBody.error === "string" ? errBody.error : typeof errBody.code === "string" ? errBody.code : "error",
        typeof errBody.message === "string" ? errBody.message : res.statusText,
        errBody,
      );
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("application/json")) {
      const data = (await res.json()) as Record<string, unknown>;
      const done: DocAIStreamDonePayload = {
        text: typeof data.text === "string" ? data.text : "",
        provider: typeof data.provider === "string" ? data.provider : undefined,
        model: typeof data.model === "string" ? data.model : undefined,
      };
      if (done.text) callbacks.onDelta?.(done.text);
      callbacks.onDone?.(done);
      return done;
    }

    if (!res.body || typeof res.body.getReader !== "function") {
      return await fallbackDocAI(req, callbacks, signal);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";
    let donePayload: DocAIStreamDonePayload | null = null;

    const handleBlock = (rawBlock: string) => {
      const parsed = parseDocAISseBlock(rawBlock);
      if (!parsed) return;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(parsed.data) as Record<string, unknown>;
      } catch {
        return;
      }

      if (parsed.event === "delta") {
        const text = typeof data.text === "string" ? data.text : "";
        if (text) {
          fullText += text;
          callbacks.onDelta?.(text);
        }
        return;
      }

      if (parsed.event === "done") {
        donePayload = {
          text: typeof data.text === "string" ? data.text : fullText,
          provider: typeof data.provider === "string" ? data.provider : undefined,
          model: typeof data.model === "string" ? data.model : undefined,
        };
        callbacks.onDone?.(donePayload);
        return;
      }

      if (parsed.event === "error") {
        const code =
          (typeof data.code === "string" && data.code) ||
          (typeof data.error === "string" && data.error) ||
          "ai_failed";
        const message =
          (typeof data.message === "string" && data.message) || "AI 请求失败";
        throw new ApiError(502, code, message, data);
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        }
        if (done) {
          buffer += decoder.decode().replace(/\r\n/g, "\n");
        }

        let sepIdx = buffer.indexOf("\n\n");
        while (sepIdx >= 0) {
          const block = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          handleBlock(block);
          sepIdx = buffer.indexOf("\n\n");
        }

        if (done) break;
      }

      if (buffer.trim()) {
        handleBlock(buffer);
      }
    } finally {
      reader.releaseLock();
    }

    if (!donePayload) {
      donePayload = { text: fullText.trim() };
      callbacks.onDone?.(donePayload);
    }

    return donePayload;
  } catch (err) {
    if (!signal?.aborted && !isAbortError(err)) {
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
    throw err;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText);
  return data as T;
}

export const aiApi = {
  settings: () => call<AISettings>("GET", "/api/me/ai"),
  save: (s: { provider: AIProvider; baseUrl: string; model: string; apiKey?: string }) => call<AISettings>("PUT", "/api/me/ai", s),
  clear: () => call<void>("DELETE", "/api/me/ai"),
  test: () => call<{ text: string }>("POST", "/api/me/ai/test"),
  /** 以某篇文档的名义调用（服务端校验可查看且允许复制该文档）。 */
  complete: (docId: number, messages: AIMessage[]) => {
    if (activeStreamContext) {
      const ctx = activeStreamContext;
      activeStreamContext = null;
      return runDocAIStream({ docId, messages }, ctx.callbacks, ctx.signal).then((r) => r.text);
    }
    return call<{ text: string }>("POST", `/api/docs/${docId}/ai`, { messages }).then((r) => r.text);
  },
  stream: (docId: number, messages: AIMessage[], callbacks?: DocAIStreamCallbacks, signal?: AbortSignal) =>
    runDocAIStream({ docId, messages }, callbacks, signal),
  completeForAccount: async (docId: number, userId: number, messages: AIMessage[], signal?: AbortSignal) => {
    const res = await fetch(`/api/bases/${docId}/ai-import-preview`, { method: "POST", credentials: "same-origin", signal, headers: { "Content-Type": "application/json", "X-Jiange-User-Id": String(userId) }, body: JSON.stringify({ messages }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText);
    if (typeof data.text !== "string") throw new Error("Invalid AI response");
    return data.text as string;
  },
  completeImageForAccount: async (docId: number, userId: number, messages: AIMessage[], image: File, signal?: AbortSignal) => {
    const form = new FormData(); form.append("messages", JSON.stringify(messages)); form.append("image", image, image.name || "image");
    const res = await fetch(`/api/bases/${docId}/ai-image-import-preview`, { method: "POST", credentials: "same-origin", signal, headers: { "X-Jiange-User-Id": String(userId), "X-Jiange-Upload": "1" }, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText);
    if (typeof data.text !== "string") throw new Error("Invalid AI response");
    return data.text as string;
  },
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
