import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiSuiteApi } from "@/lib/ai-suite-api";
import {
  buildWorkspaceHistory,
  citationHref,
  WORKSPACE_AI_STARTER_QUESTIONS,
  WorkspaceAiDialog,
  type WorkspaceAiTurn,
} from "./workspace-ai-dialog";

describe("WorkspaceAiDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders nothing when closed", () => {
    const html = renderToStaticMarkup(<WorkspaceAiDialog open={false} onClose={() => {}} />);
    expect(html).toBe("");
  });

  it("renders Feishu knowledge Q&A drawer with starter chips, mode badge, and zero native select", () => {
    const html = renderToStaticMarkup(
      <WorkspaceAiDialog open onClose={() => {}} workspaceId={3} />,
    );
    expect(html).toContain("data-workspace-ai-dialog");
    expect(html).toContain("知识库 AI 问答");
    expect(html).toContain("本地语义检索");
    expect(html).toContain('data-workspace-ai-mode="local"');
    for (const q of WORKSPACE_AI_STARTER_QUESTIONS) {
      expect(html).toContain(q);
    }
    expect(html).toContain("data-workspace-ai-input");
    expect(html).toContain("data-workspace-ai-send");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders multi-turn grounded answer with clickable citation chips and LLM badge", () => {
    const turns: WorkspaceAiTurn[] = [
      { id: "u1", role: "user", content: "查找权限与安全策略" },
      {
        id: "a1",
        role: "assistant",
        content: "空间已启用 **RBAC 权限** 与全套件水印 [1]，并在电子表格记录了审计清单 [2]。",
        mode: "llm",
        model: "gpt-4o-mini",
        citations: [
          { docId: 42, title: "安全策略与权限规范", kind: "doc", snippet: "RBAC 角色权限与水印", score: 15.2 },
          { docId: 88, title: "审计追踪表", kind: "sheet", snippet: "审计日志保留 180 天", score: 9.8 },
          { docId: 91, title: "风险登记册", kind: "base", snippet: "高风险项", score: 7.4 },
          { docId: 95, title: "安全培训课件", kind: "slides", snippet: "年度合规培训", score: 6.1 },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      <WorkspaceAiDialog
        open
        onClose={() => {}}
        initialTurns={turns}
        initialMode="llm"
        initialModel="gpt-4o-mini"
      />,
    );
    expect(html).toContain("AI 模型");
    expect(html).toContain('data-workspace-ai-mode="llm"');
    expect(html).toContain("引用来源");
    expect(html).toContain('data-ai-citation-id="42"');
    expect(html).toContain('data-ai-citation-id="88"');
    expect(html).toContain('data-ai-citation-id="91"');
    expect(html).toContain('data-ai-citation-id="95"');
    expect(html).toContain("安全策略与权限规范");
    expect(html).toContain("审计追踪表");
    expect(html).toContain("[1]");
    expect(html).toContain("[2]");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("maps citations to exact hash routes for doc, base, sheet, and slides", () => {
    expect(citationHref({ docId: 10, kind: "doc" })).toBe("#/doc/10");
    expect(citationHref({ docId: 20, kind: "base" })).toBe("#/base/20");
    expect(citationHref({ docId: 30, kind: "sheet" })).toBe("#/sheet/30");
    expect(citationHref({ docId: 40, kind: "slides" })).toBe("#/slides/40");
    expect(citationHref({ docId: 50, kind: "survey" })).toBe("#/survey/50");
    expect(citationHref({ docId: 0, kind: "doc" })).toBe("#/");
  });

  it("trims conversation history to last 8 turns and posts to /api/ai/ask-workspace", async () => {
    const turns: WorkspaceAiTurn[] = Array.from({ length: 10 }, (_, i) => ({
      id: `t-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
    }));
    const hist = buildWorkspaceHistory(turns);
    expect(hist).toHaveLength(8);
    expect(hist[0].content).toBe("msg-2");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        answer: "已汇总 [1]",
        citations: [{ docId: 7, title: "周报", kind: "doc", snippet: "核心进展", score: 10 }],
        mode: "local",
        model: "built-in-rag",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await aiSuiteApi.askWorkspace({
      question: "总结本周核心进展",
      workspaceId: 2,
      history: hist,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ai/ask-workspace");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({
      question: "总结本周核心进展",
      workspaceId: 2,
    });
    expect(res.mode).toBe("local");
    expect(res.citations[0].docId).toBe(7);
  });
});
