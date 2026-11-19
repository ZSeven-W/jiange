import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx, idKey } from "@jiange/collab";
import { embedHref, embedKindLabel, EmbedResourceBlock, parseEmbedUrl } from "./embed-block";
import { formatLocalIsoDate, ReminderBlockView, reminderStatus } from "./reminder-block";
import { blockCommentAnchor, commentSelection, isCrossBlockComment, parseCrossBlockEndChar, projectCommentAnchors } from "./comment-anchor";
import { Editor } from "./editor";
import { ReadOnlyDoc } from "@/pages/read-only-doc";
import { outlineOf } from "@/pages/outline-panel";
import { parseMarkdown, toMarkdown } from "@/lib/markdown";
import type { Comment } from "@/lib/api";
import type { SyncDoc } from "@/lib/use-sync-doc";

describe("embedded resource blocks and date reminders", () => {
  it("parses Jiange resource URLs and builds safe embed routes", () => {
    expect(parseEmbedUrl("#/sheet/42")).toEqual({ kind: "sheet", id: 42 });
    expect(parseEmbedUrl("http://127.0.0.1:5174/#/base/17?view=3")).toEqual({ kind: "base", id: 17 });
    expect(parseEmbedUrl("https://jiange.example/#/survey/9")).toEqual({ kind: "survey", id: 9 });
    expect(parseEmbedUrl("/slides/5")).toEqual({ kind: "slides", id: 5 });
    expect(parseEmbedUrl("#/doc/12")).toBeNull();
    expect(parseEmbedUrl("javascript:alert(1)")).toBeNull();
    expect(embedHref("sheet", "12")).toBe("#/sheet/12");
    expect(embedHref("base", 8)).toBe("#/base/8");
    expect(embedHref("unknown", 8)).toBe("");
    expect(embedKindLabel("survey")).toBe("问卷");
  });

  it("renders picker mode when unbound and live card shell when bound", () => {
    const picker = renderToStaticMarkup(<EmbedResourceBlock resourceKind="base" onBind={() => {}} />);
    expect(picker).toContain('data-embed-picker="base"');
    expect(picker).toContain('data-embed-tab="sheet"');
    expect(picker).toContain('data-embed-tab="survey"');

    const card = renderToStaticMarkup(<EmbedResourceBlock resourceKind="sheet" resourceId="15" title="Q4 预算表" userId={1} />);
    expect(card).toContain('data-embed-block="sheet"');
    expect(card).toContain('data-embed-id="15"');
    expect(card).toContain("Q4 预算表");
    expect(card).toContain('href="#/sheet/15"');
  });

  it("computes relative reminder badges accurately and renders reminder cards", () => {
    const now = new Date(2026, 10, 19, 10, 30); // 2026-11-19 10:30
    expect(formatLocalIsoDate(now)).toBe("2026-11-19");
    expect(reminderStatus("2026-11-19", "", false, now)).toEqual({ text: "今天", tone: "today" });
    expect(reminderStatus("2026-11-19", "09:00", false, now)).toEqual({ text: "今日已过时", tone: "overdue" });
    expect(reminderStatus("2026-11-19", "14:00", false, now)).toEqual({ text: "今天", tone: "today" });
    expect(reminderStatus("2026-11-20", "", false, now)).toEqual({ text: "明天", tone: "soon" });
    expect(reminderStatus("2026-11-24", "", false, now)).toEqual({ text: "5 天后", tone: "soon" });
    expect(reminderStatus("2026-11-17", "", false, now)).toEqual({ text: "已过期 2 天", tone: "overdue" });
    expect(reminderStatus("2026-11-17", "", true, now)).toEqual({ text: "已完成", tone: "done" });
    expect(reminderStatus("", "", false, now)).toEqual({ text: "未设日期", tone: "unset" });

    const html = renderToStaticMarkup(<ReminderBlockView date="2026-11-20" time="15:00" label="评审截止" done={false} readOnly />);
    expect(html).toContain("data-reminder-block");
    expect(html).toContain("2026-11-20");
    expect(html).toContain("15:00");
    expect(html).toContain("评审截止");
  });

  it("supports block comments on embed and reminder blocks", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const emb = tx.create("embed", null, ROOT, { resourceKind: "sheet", resourceId: "9", title: "营收表" });
    const rem = tx.create("reminder", emb, ROOT, { date: "2026-11-20", label: "提交周报" });
    expect(blockCommentAnchor(doc, emb)).toEqual({
      ok: true,
      anchor: { block: idKey(emb), startChar: "", endChar: "", quote: "[嵌入资源] 营收表" },
    });
    expect(blockCommentAnchor(doc, rem)).toEqual({
      ok: true,
      anchor: { block: idKey(rem), startChar: "", endChar: "", quote: "[日期提醒] 提交周报" },
    });
  });
});

describe("H7-H9 headings, export, outline, and cross-paragraph rendering", () => {
  it("extracts H7-H9 in outline and round-trips Markdown cleanly", () => {
    const md = "####### 七级标题\n######## 八级标题\n######### 九级标题\n";
    const parsed = parseMarkdown(md);
    expect(parsed.map((b) => b.type)).toEqual(["h7", "h8", "h9"]);
    expect(toMarkdown(parsed)).toBe(md);

    const outline = outlineOf([
      { id: "1", type: "h1", spans: [{ text: "章" }] },
      { id: "2", type: "h7", spans: [{ text: "七级" }] },
      { id: "3", type: "h8", spans: [{ text: "八级" }] },
      { id: "4", type: "h9", spans: [{ text: "九级" }] },
    ]);
    expect(outline.map((item) => item.level)).toEqual([1, 7, 8, 9]);
  });

  it("serializes embed and reminder blocks cleanly to Markdown", () => {
    const md = toMarkdown([
      { type: "embed", text: "", props: { resourceKind: "base", resourceId: "14", title: "项目排期" }, spans: [] },
      { type: "reminder", text: "", props: { date: "2026-11-25", time: "10:00", label: "上线检查", done: "" }, spans: [] },
      { type: "reminder", text: "", props: { date: "2026-11-20", label: "已完成事项", done: "true" }, spans: [] },
    ]);
    expect(md).toContain("[嵌入多维表格：项目排期](#/base/14)");
    expect(md).toContain("- [ ] ⏰ 2026-11-25 10:00 上线检查");
    expect(md).toContain("- [x] ⏰ 2026-11-20 已完成事项");
  });

  it("renders cross-paragraph highlights across editor and read-only views with single badge", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const h7 = tx.create("h7", null, ROOT);
    tx.insert(h7, 0, "七级小节");
    const p1 = tx.create("paragraph", h7, ROOT);
    tx.insert(p1, 0, "第一段核心结论");
    const p2 = tx.create("paragraph", p1, ROOT);
    tx.insert(p2, 0, "第二段数据支撑");
    const p3 = tx.create("paragraph", p2, ROOT);
    tx.insert(p3, 0, "第三段行动项");
    const rem = tx.create("reminder", p3, ROOT, { date: "2026-11-20", label: "确认上线" });
    tx.create("embed", rem, ROOT, { resourceKind: "survey", resourceId: "5", title: "满意度问卷" });

    const sel = commentSelection(doc, { a: { b: p1, o: 3 }, f: { b: p3, o: 3 } });
    expect(sel.ok).toBe(true);
    if (!sel.ok) return;
    expect(parseCrossBlockEndChar(sel.anchor.endChar)).toEqual({ endBlock: idKey(p3), endChar: idKey(doc.visibleIds(p3)[2]) });
    expect(isCrossBlockComment(sel.anchor)).toBe(true);

    const comment: Comment = {
      id: 77, docId: 1, userId: 1, userName: "审阅者",
      block: sel.anchor.block, startChar: sel.anchor.startChar, endChar: sel.anchor.endChar, quote: sel.anchor.quote,
      body: "请统一三段口径", resolved: false, createdAt: "", updatedAt: "",
    };

    expect(projectCommentAnchors(doc, p1, [comment]).threadIds).toEqual([77]);
    expect(projectCommentAnchors(doc, p2, [comment]).threadIds).toEqual([]);
    expect(projectCommentAnchors(doc, p3, [comment]).threadIds).toEqual([]);

    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const editorHtml = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} comments={[comment]} activeThread={77} />);
    expect((editorHtml.match(/data-comment-anchor="77"/g) ?? []).length).toBe(3);
    expect((editorHtml.match(/data-comment-bubble/g) ?? []).length).toBe(1);
    expect(editorHtml).toContain("七级小节");
    expect(editorHtml).toContain("data-reminder-block");
    expect(editorHtml).toContain('data-embed-block="survey"');

    const roHtml = renderToStaticMarkup(<ReadOnlyDoc view={doc.view()} commentDoc={doc} comments={[comment]} activeThread={77} onActivateComment={() => {}} />);
    expect(roHtml).toContain('aria-level="7"');
    expect((roHtml.match(/data-comment-anchor="77"/g) ?? []).length).toBe(3);
    expect(roHtml).toContain('data-embed-readonly="survey"');
    expect(roHtml).toContain("data-reminder-block");
  });
});
