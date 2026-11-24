import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  BookOpen,
  FileSpreadsheet,
  FileText,
  Loader2,
  Presentation,
  RotateCcw,
  Settings,
  Sparkles,
  Table2,
  X,
} from "lucide-react";
import {
  askWorkspaceStream,
  type WorkspaceAiCitation,
  type WorkspaceAiHistoryMessage,
} from "@/lib/workspace-ai-api";
import { aiErrorText, openAISettings } from "@/lib/ai";
import { useI18n } from "@/lib/i18n";
import { go } from "@/lib/route";
import { cn } from "@/lib/utils";

export interface WorkspaceAiTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: WorkspaceAiCitation[];
  mode?: "llm" | "local";
  model?: string;
  streaming?: boolean;
}

export const WORKSPACE_AI_STARTER_QUESTIONS: readonly string[] = [
  "总结本周核心进展",
  "查找权限与安全策略",
  "梳理待办与风险项",
];

/** Map a RAG citation to its direct hash route (#/doc/{id}, #/base/{id}, #/sheet/{id}, #/slides/{id}). */
export function citationHref(c: Pick<WorkspaceAiCitation, "docId" | "kind">): string {
  if (!Number.isSafeInteger(c.docId) || c.docId <= 0) return "#/";
  switch (c.kind) {
    case "base":
      return `#/base/${c.docId}`;
    case "sheet":
      return `#/sheet/${c.docId}`;
    case "slides":
      return `#/slides/${c.docId}`;
    case "survey":
      return `#/survey/${c.docId}`;
    case "file":
      return `#/file/${c.docId}`;
    case "folder":
      return `#/drive/${c.docId}`;
    default:
      return `#/doc/${c.docId}`;
  }
}

export function buildWorkspaceHistory(turns: readonly WorkspaceAiTurn[]): WorkspaceAiHistoryMessage[] {
  return turns.slice(-8).map((turn) => ({ role: turn.role, content: turn.content }));
}

function CitationKindIcon({ kind }: { kind: string }) {
  switch (kind) {
    case "base":
      return <Table2 size={13} className="shrink-0 text-[#7b56d9]" aria-hidden />;
    case "sheet":
      return <FileSpreadsheet size={13} className="shrink-0 text-[#00b42a]" aria-hidden />;
    case "slides":
      return <Presentation size={13} className="shrink-0 text-[#ff8800]" aria-hidden />;
    default:
      return <FileText size={13} className="shrink-0 text-[#3370ff]" aria-hidden />;
  }
}

/** Render inline **bold** segments and [1] citation badges without raw HTML injection. */
function renderInlineAnswer(line: string) {
  const tokens = line.split(/(\*\*[^*]+\*\*|\[\d+\])/g);
  return tokens.map((tok, i) => {
    if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) {
      return (
        <strong key={i} className="font-semibold text-[#1f2329] dark:text-foreground">
          {tok.slice(2, -2)}
        </strong>
      );
    }
    if (/^\[\d+\]$/.test(tok)) {
      return (
        <span
          key={i}
          className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-[#eef3ff] px-1 text-[11px] font-medium text-[#3370ff]"
        >
          {tok}
        </span>
      );
    }
    return <span key={i}>{tok}</span>;
  });
}

function StreamingCursor() {
  return (
    <span
      data-workspace-ai-cursor
      aria-hidden
      className="ml-0.5 inline-block h-[1em] w-[2px] align-text-bottom bg-[#3370ff] animate-pulse"
    />
  );
}

function GroundedAnswerBody({ text, streaming }: { text: string; streaming?: boolean }) {
  const lines = text.split("\n");
  let lastNonEmptyIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      lastNonEmptyIdx = i;
      break;
    }
  }
  if (lastNonEmptyIdx < 0) {
    return (
      <div className="min-h-[20px] text-[13.5px] leading-relaxed text-[#1f2329] dark:text-foreground">
        {streaming ? <StreamingCursor /> : null}
      </div>
    );
  }
  return (
    <div className="space-y-1.5 text-[13.5px] leading-relaxed text-[#1f2329] dark:text-foreground">
      {lines.map((raw, idx) => {
        const line = raw.trim();
        const showCursor = Boolean(streaming && idx === lastNonEmptyIdx);
        if (!line) return <div key={idx} className="h-1" />;
        if (line.startsWith("- ") || line.startsWith("• ")) {
          return (
            <div key={idx} className="flex items-start gap-2">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#3370ff]" aria-hidden />
              <p className="min-w-0 flex-1">
                {renderInlineAnswer(line.slice(2))}
                {showCursor && <StreamingCursor />}
              </p>
            </div>
          );
        }
        return (
          <p key={idx}>
            {renderInlineAnswer(line)}
            {showCursor && <StreamingCursor />}
          </p>
        );
      })}
    </div>
  );
}

export interface WorkspaceAiDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceId?: number;
  wikiSpaceId?: number;
  onNavigate?: (href: string) => void;
  /** Optional initial conversation turns (primarily for tests / restoration). */
  initialTurns?: WorkspaceAiTurn[];
  initialMode?: "llm" | "local";
  initialModel?: string;
}

export function WorkspaceAiDialog({
  open,
  onClose,
  workspaceId,
  wikiSpaceId,
  onNavigate,
  initialTurns,
  initialMode = "local",
  initialModel = "built-in-rag",
}: WorkspaceAiDialogProps) {
  const { t } = useI18n();
  const [turns, setTurns] = useState<WorkspaceAiTurn[]>(() => initialTurns ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"llm" | "local">(initialMode);
  const [model, setModel] = useState(initialModel);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
    }
  }, [open]);

  useEffect(() => () => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy, open]);

  if (!open) return null;

  const submitQuestion = async (rawQuestion?: string) => {
    const q = (rawQuestion ?? input).trim();
    if (!q || busy) return;
    const userTurn: WorkspaceAiTurn = {
      id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "user",
      content: q,
    };
    const assistantId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const history = buildWorkspaceHistory(turns);
    setTurns((prev) => [...prev, userTurn]);
    setInput("");
    setError("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const upsertAssistant = (updater: (prev?: WorkspaceAiTurn) => WorkspaceAiTurn) => {
      setTurns((prev) => {
        const idx = prev.findIndex((t) => t.id === assistantId);
        if (idx < 0) return [...prev, updater(undefined)];
        const next = prev.slice();
        next[idx] = updater(prev[idx]);
        return next;
      });
    };

    try {
      await askWorkspaceStream(
        {
          question: q,
          workspaceId: workspaceId && workspaceId > 0 ? workspaceId : undefined,
          wikiSpaceId: wikiSpaceId && wikiSpaceId > 0 ? wikiSpaceId : undefined,
          history,
        },
        {
          onCitations: (meta) => {
            setMode(meta.mode);
            setModel(meta.model);
            upsertAssistant((cur) => ({
              id: assistantId,
              role: "assistant",
              content: cur?.content ?? "",
              citations: meta.citations ?? [],
              mode: meta.mode,
              model: meta.model,
              streaming: true,
            }));
          },
          onDelta: (chunk) => {
            upsertAssistant((cur) => ({
              id: assistantId,
              role: "assistant",
              content: (cur?.content ?? "") + chunk,
              citations: cur?.citations ?? [],
              mode: cur?.mode ?? mode,
              model: cur?.model ?? model,
              streaming: true,
            }));
          },
          onDone: (res) => {
            setMode(res.mode);
            setModel(res.model);
            upsertAssistant((cur) => ({
              id: assistantId,
              role: "assistant",
              content: res.answer || cur?.content || "",
              citations: res.citations ?? cur?.citations ?? [],
              mode: res.mode,
              model: res.model,
              streaming: false,
            }));
          },
        },
        controller.signal,
      );
    } catch (err) {
      setTurns((prev) =>
        prev
          .map((t) => (t.id === assistantId ? { ...t, streaming: false } : t))
          .filter((t) => t.id !== assistantId || t.content.trim().length > 0),
      );
      if (!controller.signal.aborted) {
        setError(aiErrorText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCitationClick = (c: WorkspaceAiCitation) => {
    const href = citationHref(c);
    if (onNavigate) onNavigate(href);
    else go(href);
    onClose();
  };

  const handleReset = () => {
    abortRef.current?.abort();
    setTurns([]);
    setError("");
    setBusy(false);
    inputRef.current?.focus();
  };

  const dialogContent = (
    <div
      className="fixed inset-0 z-[115] flex justify-end bg-black/25 backdrop-blur-[1px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("知识库 AI 问答")}
        data-workspace-ai-dialog
        className="flex h-full w-full max-w-[520px] flex-col border-l border-[#dee0e3] bg-surface text-foreground shadow-[0_12px_40px_rgba(31,35,41,0.18)]"
      >
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[#eceef2] px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[#3370ff] to-[#6b5bff] text-white shadow-xs">
              <Sparkles size={16} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-[15px] font-semibold text-[#1f2329] dark:text-foreground">
                  {t("知识库 AI 问答")}
                </h2>
                <span
                  data-workspace-ai-mode={mode}
                  title={model}
                  className={cn(
                    "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium",
                    mode === "llm"
                      ? "bg-[#eef3ff] text-[#3370ff]"
                      : "bg-[#f2f3f5] text-[#646a73]",
                  )}
                >
                  {mode === "llm" ? t("AI 模型") : t("本地语义检索")}
                </span>
              </div>
              <p className="truncate text-[11.5px] text-[#8f959e]">
                {t("仅检索你有权访问且允许复制的文档，回答附带引用溯源")}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => openAISettings()}
              title={t("AI 设置")}
              aria-label={t("AI 设置")}
              className="grid size-7 place-items-center rounded-md text-[#646a73] hover:bg-hover hover:text-foreground"
            >
              <Settings size={15} />
            </button>
            {turns.length > 0 && (
              <button
                type="button"
                onClick={handleReset}
                title={t("清空对话")}
                aria-label={t("清空对话")}
                data-workspace-ai-reset
                className="grid size-7 place-items-center rounded-md text-[#646a73] hover:bg-hover hover:text-foreground"
              >
                <RotateCcw size={15} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title={t("关闭")}
              aria-label={t("关闭")}
              data-workspace-ai-close
              className="grid size-7 place-items-center rounded-md text-[#646a73] hover:bg-hover hover:text-foreground"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {/* Body / Conversation */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {turns.length === 0 ? (
            <div className="flex h-full flex-col justify-center py-6">
              <div className="rounded-xl border border-[#eceef2] bg-[#f7f8fa] p-4 dark:bg-sidebar">
                <div className="flex items-center gap-2 text-[13px] font-medium text-[#1f2329] dark:text-foreground">
                  <BookOpen size={15} className="text-[#3370ff]" />
                  <span>{t("试试向空间知识库提问")}</span>
                </div>
                <p className="mt-1.5 text-[12px] leading-5 text-[#646a73]">
                  {t("支持跨文档、多维表格、电子表格与幻灯片快速检索，自动聚合要点并标注原文出处。")}
                </p>
                <div className="mt-3.5 flex flex-wrap gap-2" data-workspace-ai-starters>
                  {WORKSPACE_AI_STARTER_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      data-workspace-ai-starter
                      disabled={busy}
                      onClick={() => void submitQuestion(t(q))}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[#dee0e3] bg-surface px-3 py-1.5 text-[12.5px] text-[#1f2329] transition-colors hover:border-[#3370ff] hover:bg-[#f0f5ff] hover:text-[#3370ff] disabled:opacity-50 dark:text-foreground"
                    >
                      <Sparkles size={12} className="text-[#3370ff]" />
                      <span>{t(q)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4" data-workspace-ai-messages>
              {turns.map((turn) =>
                turn.role === "user" ? (
                  <div key={turn.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-[#3370ff] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white shadow-xs">
                      {turn.content}
                    </div>
                  </div>
                ) : (
                  <article
                    key={turn.id}
                    data-workspace-ai-answer
                    data-workspace-ai-streaming={turn.streaming ? "true" : undefined}
                    className="rounded-xl border border-[#e5e6eb] bg-surface p-4 shadow-[0_2px_8px_rgba(31,35,41,0.04)]"
                  >
                    <GroundedAnswerBody text={turn.content} streaming={turn.streaming} />

                    {turn.citations && turn.citations.length > 0 && (
                      <div className="mt-3.5 border-t border-[#eff0f1] pt-3" data-workspace-ai-citations>
                        <div className="mb-2 text-[11.5px] font-medium text-[#8f959e]">
                          {t("引用来源")} ({turn.citations.length})
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {turn.citations.map((c, idx) => (
                            <button
                              key={`${c.docId}-${idx}`}
                              type="button"
                              data-ai-citation-id={String(c.docId)}
                              title={c.snippet}
                              onClick={() => handleCitationClick(c)}
                              className="group inline-flex max-w-full items-center gap-1.5 rounded-md border border-[#dee0e3] bg-[#f7f8fa] px-2.5 py-1 text-left text-[12px] text-[#1f2329] transition-colors hover:border-[#3370ff] hover:bg-[#eef3ff] hover:text-[#3370ff] dark:bg-sidebar dark:text-foreground"
                            >
                              <span className="shrink-0 font-semibold text-[#3370ff]">[{idx + 1}]</span>
                              <CitationKindIcon kind={c.kind} />
                              <span className="max-w-[220px] truncate">{c.title}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </article>
                ),
              )}

              {busy && !turns.some((turn) => turn.streaming) && (
                <div className="flex items-center gap-2 rounded-xl border border-[#e5e6eb] bg-[#f7f8fa] px-4 py-3 text-[13px] text-[#646a73]">
                  <Loader2 size={15} className="animate-spin text-[#3370ff]" />
                  <span>{t("正在检索知识库并生成回答…")}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div role="alert" className="mx-5 mb-2 rounded-md border border-[#ffccc7] bg-[#fff2f0] px-3 py-2 text-[12px] text-[#d83931]">
            {error}
          </div>
        )}

        {/* Input footer */}
        <footer className="shrink-0 border-t border-[#eceef2] bg-surface px-5 py-3.5">
          <div className="flex items-end gap-2 rounded-xl border border-[#dee0e3] bg-[#f7f8fa] p-2 focus-within:border-[#3370ff] focus-within:bg-surface dark:bg-sidebar">
            <textarea
              ref={inputRef}
              rows={2}
              value={input}
              disabled={busy}
              data-workspace-ai-input
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submitQuestion();
                }
              }}
              placeholder={t("输入你想在知识库中查询或总结的问题…")}
              className="max-h-32 min-h-[42px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[13.5px] leading-5 outline-none"
            />
            <button
              type="button"
              disabled={busy || !input.trim()}
              data-workspace-ai-send
              aria-label={t("发送问题")}
              onClick={() => void submitQuestion()}
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#3370ff] text-white transition-colors hover:bg-[#245bdb] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={16} />}
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-[#8f959e]">
            <span>{t("按 Enter 发送，Shift + Enter 换行")}</span>
            <span>{mode === "llm" ? model : t("未配置密钥时自动启用本地语义检索")}</span>
          </div>
        </footer>
      </section>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(dialogContent, document.body) : dialogContent;
}
