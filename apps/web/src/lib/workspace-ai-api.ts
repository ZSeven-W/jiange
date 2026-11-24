import { ApiError } from "./api";
import {
  aiSuiteApi,
  type AskWorkspaceRequest,
  type AskWorkspaceResponse,
  type WorkspaceAiCitation,
  type WorkspaceAiHistoryMessage,
} from "./ai-suite-api";

export type {
  AskWorkspaceRequest,
  AskWorkspaceResponse,
  WorkspaceAiCitation,
  WorkspaceAiHistoryMessage,
};

export interface WorkspaceAiStreamCitationsPayload {
  citations: WorkspaceAiCitation[];
  mode: "llm" | "local";
  model: string;
  retrieval?: string;
}

export interface WorkspaceAiStreamDonePayload extends AskWorkspaceResponse {
  retrieval?: string;
}

export interface WorkspaceAiStreamCallbacks {
  onCitations?: (payload: WorkspaceAiStreamCitationsPayload) => void;
  onDelta?: (text: string) => void;
  onDone?: (payload: WorkspaceAiStreamDonePayload) => void;
}

export interface ParsedSseEvent {
  event: string;
  data: string;
}

/** Parse one complete SSE frame (lines separated by \n, no trailing blank line). */
export function parseSseEventBlock(block: string): ParsedSseEvent | null {
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

async function fallbackAskWorkspace(
  payload: AskWorkspaceRequest,
  callbacks: WorkspaceAiStreamCallbacks,
  signal?: AbortSignal,
): Promise<WorkspaceAiStreamDonePayload> {
  const res = await aiSuiteApi.askWorkspace(payload, signal);
  const done: WorkspaceAiStreamDonePayload = {
    answer: res.answer ?? "",
    citations: res.citations ?? [],
    mode: res.mode,
    model: res.model,
  };
  callbacks.onCitations?.({
    citations: done.citations,
    mode: done.mode,
    model: done.model,
  });
  if (done.answer) {
    callbacks.onDelta?.(done.answer);
  }
  callbacks.onDone?.(done);
  return done;
}

/**
 * Stream Workspace AI Q&A over SSE (`POST /api/ai/workspace-ask/stream`).
 * Automatically falls back to `POST /api/ai/ask-workspace` if the streaming
 * endpoint returns 404/405/501 or the runtime does not expose a readable stream.
 */
export async function askWorkspaceStream(
  payload: AskWorkspaceRequest,
  callbacks: WorkspaceAiStreamCallbacks = {},
  signal?: AbortSignal,
): Promise<WorkspaceAiStreamDonePayload> {
  const res = await fetch("/api/ai/workspace-ask/stream", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return fallbackAskWorkspace(payload, callbacks, signal);
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      errBody.error ?? "error",
      errBody.message ?? res.statusText,
      errBody,
    );
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as WorkspaceAiStreamDonePayload;
    const done: WorkspaceAiStreamDonePayload = {
      answer: data.answer ?? "",
      citations: data.citations ?? [],
      mode: data.mode ?? "local",
      model: data.model ?? "built-in-rag",
      retrieval: data.retrieval,
    };
    callbacks.onCitations?.({
      citations: done.citations,
      mode: done.mode,
      model: done.model,
      retrieval: done.retrieval,
    });
    if (done.answer) callbacks.onDelta?.(done.answer);
    callbacks.onDone?.(done);
    return done;
  }

  if (!res.body || typeof res.body.getReader !== "function") {
    return fallbackAskWorkspace(payload, callbacks, signal);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let buffer = "";
  let citations: WorkspaceAiCitation[] = [];
  let mode: "llm" | "local" = "local";
  let model = "built-in-rag";
  let retrieval: string | undefined;
  let answer = "";
  let donePayload: WorkspaceAiStreamDonePayload | null = null;

  const handleBlock = (rawBlock: string) => {
    const parsedEvent = parseSseEventBlock(rawBlock);
    if (!parsedEvent) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(parsedEvent.data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsedEvent.event === "citations") {
      citations = Array.isArray(data.citations) ? (data.citations as WorkspaceAiCitation[]) : [];
      mode = data.mode === "llm" ? "llm" : "local";
      model = typeof data.model === "string" && data.model ? data.model : "built-in-rag";
      retrieval = typeof data.retrieval === "string" ? data.retrieval : undefined;
      callbacks.onCitations?.({ citations, mode, model, retrieval });
      return;
    }

    if (parsedEvent.event === "delta") {
      const text = typeof data.text === "string" ? data.text : "";
      if (text) {
        answer += text;
        callbacks.onDelta?.(text);
      }
      return;
    }

    if (parsedEvent.event === "done") {
      const finalAnswer = typeof data.answer === "string" ? data.answer : answer;
      const finalCitations = Array.isArray(data.citations)
        ? (data.citations as WorkspaceAiCitation[])
        : citations;
      const finalMode: "llm" | "local" = data.mode === "llm" ? "llm" : data.mode === "local" ? "local" : mode;
      const finalModel = typeof data.model === "string" && data.model ? data.model : model;
      const finalRetrieval = typeof data.retrieval === "string" ? data.retrieval : retrieval;
      donePayload = {
        answer: finalAnswer,
        citations: finalCitations,
        mode: finalMode,
        model: finalModel,
        retrieval: finalRetrieval,
      };
      callbacks.onDone?.(donePayload);
      return;
    }

    if (parsedEvent.event === "error") {
      const code = typeof data.error === "string" ? data.error : "ai_failed";
      const message = typeof data.message === "string" ? data.message : "AI 请求失败";
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
    donePayload = {
      answer: answer.trim(),
      citations,
      mode,
      model,
      retrieval,
    };
    callbacks.onDone?.(donePayload);
  }

  return donePayload;
}

export const workspaceAiApi = {
  askWorkspace: aiSuiteApi.askWorkspace,
  askWorkspaceStream,
};
