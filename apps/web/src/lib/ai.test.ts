import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { AI_MAX_INPUT, aiErrorText, blockPrompt, docPrompt } from "./ai";

describe("AI prompts", () => {
  it("builds block prompts with a system rule and the block text", () => {
    const m = blockPrompt("translate-en", "你好");
    expect(m[0].role).toBe("system");
    expect(m[1].content).toContain("翻译成英文");
    expect(m[1].content).toContain("你好");
    expect(blockPrompt("custom", "原文", "改成口语").at(-1)!.content.startsWith("改成口语")).toBe(true);
  });
  it("clips long documents to stay under the server input limit", () => {
    const m = docPrompt("标题", "字".repeat(AI_MAX_INPUT * 2), [], "总结");
    const total = m.reduce((n, x) => n + x.content.length, 0);
    expect(total).toBeLessThanOrEqual(AI_MAX_INPUT);
    expect(m[0].content).toContain("已截断");
    expect(m.at(-1)).toEqual({ role: "user", content: "总结" });
  });
  it("keeps only recent history and shows server messages", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, content: String(i) }));
    expect(docPrompt("t", "b", history, "q").length).toBe(1 + 8 + 1);
    expect(aiErrorText(new ApiError(412, "ai_not_configured", "尚未配置 AI"))).toBe("尚未配置 AI");
  });
});
