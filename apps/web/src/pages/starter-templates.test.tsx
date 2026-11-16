import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StarterTemplates, starterTemplateCount } from "./starter-templates";
import { filterTemplateCatalog } from "./template-library";
import { STARTER_TEMPLATES } from "./starter-template-data";

describe("starter template previews", () => {
  it("shows the content each visible template will insert", () => {
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><StarterTemplates onChoose={() => {}} onHide={() => {}} /></QueryClientProvider>);
    for (const section of ["会议信息", "本周工作", "本周待办", "项目背景"]) expect(html).toContain(section);
    expect(html).toContain("会议时间：");
    expect(html).toContain("任务一");
    expect(html).toContain("在这里描述项目背景。");
  });

  it("reserves room for the library entry at narrow widths", () => {
    expect(starterTemplateCount(150)).toBe(0);
    expect(starterTemplateCount(264)).toBe(1);
    expect(starterTemplateCount(316)).toBe(1);
    expect(starterTemplateCount(482)).toBe(2);
    expect(starterTemplateCount(814)).toBe(4);
  });

  it("filters built-in categories and keeps personal templates separate", () => {
    const own = { id: "u:1", name: "我的会议记录", body: "会议", color: "#fff", userTemplateId: 1 };
    const all = [own, ...STARTER_TEMPLATES];
    expect(filterTemplateCatalog(all, "mine", "会议")).toEqual([own]);
    expect(filterTemplateCatalog(all, "meeting", "会议").map((item) => item.id)).toEqual(["meeting"]);
    expect(filterTemplateCatalog(all, "project", "不存在")).toEqual([]);
  });
});
