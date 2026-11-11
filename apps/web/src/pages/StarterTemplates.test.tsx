import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StarterTemplates } from "./StarterTemplates";

describe("starter template previews", () => {
  it("shows the content each visible template will insert", () => {
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><StarterTemplates onChoose={() => {}} onHide={() => {}} /></QueryClientProvider>);
    for (const section of ["会议信息", "本周工作", "本周待办", "项目背景"]) expect(html).toContain(section);
    expect(html).toContain("会议时间：");
    expect(html).toContain("任务一");
    expect(html).toContain("在这里描述项目背景。");
  });
});
