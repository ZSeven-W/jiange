import { ApiError } from "./api";

export interface WorkspaceAiCitation {
  docId: number;
  title: string;
  kind: "doc" | "base" | "sheet" | "slides" | "survey" | "file" | "folder" | string;
  wikiSpaceId?: number | null;
  snippet: string;
  score: number;
}

export interface WorkspaceAiHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AskWorkspaceRequest {
  question: string;
  workspaceId?: number;
  wikiSpaceId?: number;
  history?: WorkspaceAiHistoryMessage[];
}

export interface AskWorkspaceResponse {
  answer: string;
  citations: WorkspaceAiCitation[];
  mode: "llm" | "local";
  model: string;
}

export interface SheetAssistRequest {
  prompt: string;
  headers?: string[];
  sampleRows?: string[][];
  activeCell?: string;
  sheetTitle?: string;
}

export interface SheetAssistResponse {
  answer: string;
  suggestedFormula?: string;
  explanation: string;
  mode: "llm" | "local";
}

export type BaseFillPreset =
  | "summarize"
  | "classify"
  | "translate_en"
  | "extract_keywords"
  | "custom";

export interface BaseFillRowInput {
  recordId: number;
  text: string;
}

export interface BaseFillRequest {
  baseId: number;
  preset: BaseFillPreset;
  customPrompt?: string;
  sourceFieldName: string;
  targetFieldType: string;
  options?: string[];
  rows: BaseFillRowInput[];
}

export interface BaseFillResultRow {
  recordId: number;
  value: string;
}

export interface BaseFillResponse {
  results: BaseFillResultRow[];
  mode: "llm" | "local";
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText, data);
  }
  return data as T;
}

export const aiSuiteApi = {
  askWorkspace: (input: AskWorkspaceRequest, signal?: AbortSignal) =>
    postJson<AskWorkspaceResponse>("/api/ai/ask-workspace", input, signal),

  sheetAssist: (input: SheetAssistRequest, signal?: AbortSignal) =>
    postJson<SheetAssistResponse>("/api/ai/sheet-assist", input, signal),

  baseFill: (input: BaseFillRequest, signal?: AbortSignal) =>
    postJson<BaseFillResponse>("/api/ai/base-fill", input, signal),
};
