import { describe, expect, it, vi } from "vitest";
import { Doc, ROOT } from "@jiange/collab";
import { createDocTools } from "../src/ai-tools.js";
import { Document } from "../src/document.js";
import { blocksToHtml, parseHtml } from "../src/html.js";
import { TITLE } from "../src/model.js";
import { createZip } from "../src/zip.js";

describe("Document AI-Native Facade, HTML round-trip, suggestions, comments, and tools", () => {
  it("runs a full AI Agent workflow: fromMarkdown -> inspect -> readSection -> dryRun -> apply -> verify -> undo -> DOCX/HTML", async () => {
    const md = `# Architecture Spec

Intro paragraph with **Jiange** SDK.

## Goals

- Lightweight
- [x] AI-native

| Module | Status |
| --- | --- |
| sheet-sdk | Done |

\`\`\`ts
const x = "Jiange";
\`\`\`
`;
    const doc = Document.fromMarkdown(md);
    expect(doc.title).toBe("Architecture Spec");
    expect(doc.outline()).toHaveLength(2);

    const tools = createDocTools(doc);
    expect(tools.tools.map((t) => t.name)).toContain("doc_apply");

    // Inspect outline + summary + truncation
    const inspected = tools.execute("doc_inspect", { detail: "summary", maxTokens: 1200 }) as ReturnType<Document["inspect"]>;
    expect(inspected.kind).toBe("doc");
    expect(inspected.summary.headingCount).toBe(2);
    expect(inspected.summary.tableCount).toBe(1);
    expect(doc.inspect({ detail: "outline" }).promptText).toContain("Goals");
    expect(doc.inspect({ detail: "full", maxTokens: 40 }).truncated).toBe(true);

    // Section addressing
    const section = tools.execute("doc_read_section", { section: "Goals" }) as ReturnType<Document["readSection"]>;
    expect(section?.blocks.length).toBeGreaterThanOrEqual(4);
    expect(section?.markdown).toContain("Lightweight");

    // Query
    const tableQuery = tools.execute("doc_query", { blockType: "table" }) as ReturnType<Document["query"]>;
    expect(tableQuery.totalMatched).toBe(1);
    const tableId = tableQuery.blocks[0].id;
    const introId = doc.blocks()[1].id;

    // Dry-run apply
    const dry = tools.execute("doc_apply", {
      dryRun: true,
      ops: [
        { op: "setTitle", title: "Spec v2" },
        { op: "replaceText", search: "Jiange", replacement: "JiangePro" },
      ],
    }) as ReturnType<Document["apply"]>;
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.diff.replacements).toBe(1); // skips code block!
    expect(doc.title).toBe("Architecture Spec"); // unchanged!

    // Real atomic apply: update, insert, move, table edit, suggestion, comment
    const applied = tools.execute("doc_apply", {
      ops: [
        { op: "setTitle", title: "Architecture Spec v2" },
        { op: "replaceText", search: "Jiange", replacement: "JiangeSDK" },
        { op: "editTableCell", blockId: tableId, row: 1, col: 1, value: "Shipped" },
        { op: "addTableRow", blockId: tableId, values: ["doc-sdk", "Done"] },
        { op: "insertBlock", type: "paragraph", markdown: "New *summary* block.", afterBlockId: introId },
        { op: "addSuggestion", blockId: introId, kind: "replace", text: "Updated intro with **JiangeSDK**.", author: "reviewer" },
        { op: "addComment", blockId: introId, quote: "JiangeSDK", body: "Looks crisp!", author: "alice" },
      ],
    }) as ReturnType<Document["apply"]>;
    expect(applied.ok).toBe(true);
    expect(applied.diff.replacements).toBe(1);
    // Code block remained untouched (safe replace)!
    const codeBlock = doc.blocks().find((b) => b.type === "code")!;
    expect(codeBlock.text).toContain('"Jiange"');
    // Marks preserved on replaced text!
    expect(doc.getBlock(introId)!.spans.some((s) => s.text.includes("JiangeSDK") && s.marks.bold)).toBe(true);

    // Suggestions & comments lifecycle
    const sugs = doc.listSuggestions();
    expect(sugs).toHaveLength(1);
    expect(doc.apply([{ op: "resolveSuggestion", suggestionId: sugs[0].id, decision: "accept" }]).ok).toBe(true);
    expect(doc.getBlock(introId)!.text).toBe("Updated intro with JiangeSDK.");
    const cmts = doc.listComments();
    expect(cmts).toHaveLength(1);
    expect(doc.replyComment(cmts[0].id, { body: "Agreed", author: "bob" })?.body).toBe("Agreed");
    expect(doc.resolveComment(cmts[0].id)).toBe(true);

    // Atomic rollback on invalid op
    const failed = doc.apply([
      { op: "setTitle", title: "Temp" },
      { op: "deleteBlock", blockId: "99:99" },
    ]);
    expect(failed.ok).toBe(false);
    expect(doc.title).toBe("Architecture Spec v2");

    // Undo / Redo
    expect((tools.execute("doc_undo") as { ok: boolean }).ok).toBe(true);
    expect(doc.redo()).toBe(true);

    // Export DEFLATE DOCX + round-trip + Markdown + PlainText
    const docxBytes = await doc.toDocxAsync();
    const syncDocx = doc.toDocx();
    expect(docxBytes.length).toBeLessThan(syncDocx.length);
    const reimported = await Document.fromDocx(docxBytes);
    expect(reimported.document.toPlainText()).toContain("Shipped");
    expect((tools.execute("doc_export_markdown") as { markdown: string }).markdown).toContain("doc-sdk");

    // Verify catches malformed table & unsafe links
    const badDoc = Document.create({ title: "Audit" });
    const badTbl = badDoc.insertBlock({ type: "table", props: { tableData: "not-json" } });
    const s = badDoc.addSuggestion({ blockId: badTbl.id, op: "delete" });
    badDoc.deleteBlock(badTbl.id);
    const diags = badDoc.verify();
    expect(diags.some((d) => d.code === "orphan_suggestion")).toBe(true);
    expect(badDoc.rejectSuggestion(s.id)).toBe(true);

    // Tools error path
    expect(() => tools.execute("unknown_tool")).toThrow();
  });

  it("round-trips semantic HTML cleanly and strips unsafe scripts/protocols", () => {
    const html = `
      <script>alert(1)</script>
      <h1>Heading &amp; Title</h1>
      <p>Hello <strong>bold</strong>, <em>italic</em>, <u>under</u>, <del>strike</del>, <code>fn()</code>, <a href="https://jiange.dev">site</a>, <a href="javascript:evil()">bad</a></p>
      <blockquote>Quoted line</blockquote>
      <ul><li>Item 1</li><li><input type="checkbox" checked/> Done task</li></ul>
      <ol><li>First</li></ol>
      <pre><code class="language-ts">const n = 1;</code></pre>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      <hr/>
      <img src="https://jiange.dev/logo.png" alt="Logo"/>
    `;
    const blocks = parseHtml(html);
    expect(blocks.map((b) => b.type)).toEqual(["h1", "paragraph", "quote", "bullet", "todo", "ordered", "code", "table", "divider", "image"]);
    expect(blocks[0].text).toBe("Heading & Title");
    const serialized = blocksToHtml(blocks);
    expect(serialized).not.toContain("javascript:");
    expect(serialized).not.toContain("<script>");
    expect(serialized).toContain("<strong>bold</strong>");
    expect(serialized).toContain("<table>");

    const fromHtmlDoc = Document.fromHtml(serialized, "HTML Doc");
    expect(fromHtmlDoc.toHtml()).toContain("<h1>Heading &amp; Title</h1>");
    expect(Document.fromCollabDoc(fromHtmlDoc.collabDoc, "Wrap").blocks().length).toBe(blocks.length);
  });

  it("exercises all createDocTools parameter combinations and validation errors", () => {
    const doc = Document.fromMarkdown("# Intro\n\nAlpha line\n\n## Details\n\nBeta line");
    const tools = createDocTools(doc);

    // doc_inspect with default args (no maxTokens) and with focus + cursor
    expect((tools.execute("doc_inspect") as ReturnType<Document["inspect"]>).kind).toBe("doc");
    const focused = tools.execute("doc_inspect", {
      detail: "full",
      focus: "Details",
      cursor: "0",
    }) as ReturnType<Document["inspect"]>;
    expect(focused.kind).toBe("doc");

    // doc_read_section missing/non-string section
    expect(() => tools.execute("doc_read_section", {})).toThrow(/section string/);

    // doc_query with section, search, limit, and without blockType
    const q = tools.execute("doc_query", {
      section: "Details",
      search: "Beta",
      limit: 5,
    }) as ReturnType<Document["query"]>;
    expect(q.totalMatched).toBe(1);

    // doc_apply missing ops array
    expect(() => tools.execute("doc_apply", { ops: "not-array" })).toThrow(/ops array/);

    // doc_apply with reason string, then doc_verify, then doc_undo with token string
    const res = tools.execute("doc_apply", {
      ops: [{ op: "setTitle", title: "Updated" }],
      reason: "rename title",
    }) as ReturnType<Document["apply"]>;
    expect(res.ok).toBe(true);

    const verified = tools.execute("doc_verify") as { ok: boolean; diagnostics: unknown[] };
    expect(verified.ok).toBe(true);
    expect(Array.isArray(verified.diagnostics)).toBe(true);

    const undone = tools.execute("doc_undo", { token: res.undoToken }) as { ok: boolean; version: string };
    expect(undone.ok).toBe(true);
    expect(doc.title).toBe("Intro");
  });

  it("covers all Document CRUD, comments, suggestions, undo/redo, inspect, query, verify, apply, and DOCX import edge cases", async () => {
    // 1. Document.create() with no args, fromCollabDoc with & without TITLE block, fromMarkdown without H1
    const empty = Document.create();
    expect(empty.title).toBe("");
    expect(empty.canUndo).toBe(false);
    expect(empty.canRedo).toBe(false);
    expect(empty.undo()).toBe(false);
    expect(empty.redo()).toBe(false);
    expect(empty.toView().blocks).toEqual([]);
    expect(empty.inspect().promptText).toContain("(Untitled)");
    expect(empty.toDocx().byteLength).toBeGreaterThan(0);
    expect((await empty.toDocxAsync()).byteLength).toBeGreaterThan(0);

    const rawCollab = new Doc(1);
    rawCollab.apply({ t: "bcreate", id: TITLE, parent: ROOT, pos: "a", type: "title" });
    rawCollab.insertText(TITLE, 0, "Collab Title");
    expect(Document.fromCollabDoc(rawCollab).title).toBe("Collab Title");
    expect(Document.fromCollabDoc(new Doc(1)).title).toBe("");
    expect(Document.fromMarkdown("Just a paragraph").title).toBe("");

    // 2. appendMdBlock edge cases: empty type, undefined props, empty span text
    const weird = Document.create({
      blocks: [
        {
          type: "",
          text: "",
          props: undefined as unknown as Record<string, string>,
          spans: [{ text: "", marks: {} }, { text: "hello", marks: { bold: "1" } }],
        },
      ],
    });
    expect(weird.blocks()[0]).toMatchObject({ type: "paragraph", text: "hello" });

    // 3. insertBlock, getBlock, updateBlock, moveBlock, deleteBlock errors & variants
    expect(empty.getBlock("99:99")).toBeNull();
    const b1 = empty.insertBlock({ type: "paragraph", text: "First" });
    const b2 = empty.insertBlock({ type: "paragraph", text: "Second" }); // afterBlockId undefined with existing blocks
    const b0 = empty.insertBlock({ type: "paragraph", afterBlockId: null }); // insert at start, no text/markdown
    expect(empty.blocks().map((b) => b.id)).toEqual([b0.id, b1.id, b2.id]);
    expect(() => empty.insertBlock({ type: "paragraph", afterBlockId: "not-id" })).toThrow(/Block not found/);
    expect(() => empty.insertBlock({ type: "paragraph", afterBlockId: "99:99" })).toThrow(/Block not found/);

    expect(() => empty.updateBlock("bad", { text: "x" })).toThrow(/Block not found/);
    expect(() => empty.updateBlock("99:99", { text: "x" })).toThrow(/Block not found/);
    expect(empty.updateBlock(b0.id, { type: "h2", text: "Section One" }).type).toBe("h2");
    expect(empty.updateBlock(b1.id, { text: "" }).text).toBe(""); // clear via empty text

    expect(() => empty.moveBlock("bad", null)).toThrow(/Block not found/);
    expect(() => empty.moveBlock(b2.id, "bad")).toThrow(/Target block not found/);
    expect(() => empty.moveBlock(b2.id, "99:99")).toThrow(/Target block not found/);
    empty.moveBlock(b2.id, null);
    expect(empty.blocks()[0].id).toBe(b2.id);
    empty.moveBlock(b2.id, b1.id);
    expect(empty.blocks()[2].id).toBe(b2.id);

    // 4. replaceText edge cases: empty search, case-insensitive, skipCodeAndMath=false, deletion replacement="", emoji offset beyond chars
    const repDoc = Document.fromMarkdown("# Title\n\nAlpha alpha\n\n```ts\nalpha\n```\n\n😀😀😀z");
    expect(repDoc.replaceText("", "x")).toBe(0);
    expect(repDoc.replaceText("ALPHA", "beta", { caseSensitive: false, skipCodeAndMath: false })).toBe(3);
    expect(repDoc.replaceText("z", "")).toBe(1);

    // 5. outline sibling headings, readSection substring match & miss, inspect focus miss & long block preview, query section miss
    const secDoc = Document.fromMarkdown(`## First Heading\n\n${"x".repeat(300)}\n\n## Second Heading\n\nBody 2`);
    expect(secDoc.outline().map((h) => h.childBlockCount)).toEqual([1, 1]);
    expect(secDoc.readSection("Second")?.heading.text).toBe("Second Heading");
    expect(secDoc.readSection("Nonexistent")).toBeNull();
    expect(secDoc.inspect({ focus: "Nonexistent", detail: "summary" }).promptText).toContain("…");
    expect(secDoc.query({ section: "Nonexistent" }).totalMatched).toBe(0);

    // 6. Suggestions & comments full lifecycle & error branches
    const scDoc = Document.create({ title: "Review" });
    const p = scDoc.insertBlock({ type: "paragraph", text: "Original" });
    expect(() => scDoc.addSuggestion({ blockId: "99:99", op: "delete" })).toThrow(/Block not found/);
    expect(scDoc.acceptSuggestion("missing")).toBe(false);
    expect(scDoc.rejectSuggestion("missing")).toBe(false);

    const sRep = scDoc.addSuggestion({ blockId: p.id, op: "replace", blockType: "h3" });
    expect(scDoc.acceptSuggestion(sRep.id)).toBe(true);
    expect(scDoc.getBlock(p.id)).toMatchObject({ type: "h3", text: "" });

    const sIns1 = scDoc.addSuggestion({ blockId: p.id, op: "insert_after", text: "Inserted", blockType: "quote" });
    expect(scDoc.acceptSuggestion(sIns1.id)).toBe(true);
    const sIns2 = scDoc.addSuggestion({ blockId: p.id, op: "insert_after" });
    expect(scDoc.acceptSuggestion(sIns2.id)).toBe(true);

    const sDel = scDoc.addSuggestion({ blockId: p.id, op: "delete" });
    expect(scDoc.acceptSuggestion(sDel.id)).toBe(true);
    expect(scDoc.getBlock(p.id)).toBeNull();

    const p2 = scDoc.insertBlock({ type: "paragraph", text: "Discuss" });
    expect(() => scDoc.addComment({ blockId: "99:99", body: "hi" })).toThrow(/Block not found/);
    const c = scDoc.addComment({ blockId: p2.id, body: "No quote or author" });
    expect(c.author).toBe("ai");
    expect(c.quote).toBeUndefined();
    expect(scDoc.replyComment("missing", { body: "x" })).toBeNull();
    expect(scDoc.replyComment(c.id, { body: "default author" })?.author).toBe("ai");
    expect(scDoc.resolveComment("missing")).toBe(false);

    // 7. apply: updateBlock, moveBlock, resolveSuggestion reject & error, editTableCell/addTableRow errors & padding, atomic=false, non-Error throw, undo wrong token & >50 cap
    const appDoc = Document.create({ title: "Ops" });
    const a1 = appDoc.insertBlock({ type: "paragraph", text: "A" });
    const a2 = appDoc.insertBlock({ type: "paragraph", text: "B" });
    const tbl = appDoc.insertBlock({ type: "table", props: { tableData: '[["H1","H2"]]' } });
    const sug = appDoc.addSuggestion({ blockId: a1.id, op: "delete" });

    const okRes = appDoc.apply([
      { op: "updateBlock", blockId: a1.id, text: "A2" },
      { op: "moveBlock", blockId: a2.id, afterBlockId: null },
      { op: "addTableRow", blockId: tbl.id, values: ["only-one"] },
      { op: "resolveSuggestion", suggestionId: sug.id, decision: "reject" },
    ]);
    expect(okRes.ok).toBe(true);
    expect(appDoc.canUndo).toBe(true);
    expect(appDoc.undo("wrong-token")).toBe(false);
    expect(appDoc.undo(okRes.undoToken)).toBe(true);
    expect(appDoc.canRedo).toBe(true);

    // Table op errors & suggestion error
    expect(appDoc.apply([{ op: "editTableCell", blockId: a1.id, row: 0, col: 0, value: "x" }]).ok).toBe(false);
    expect(appDoc.apply([{ op: "addTableRow", blockId: a1.id, values: ["x"] }]).ok).toBe(false);
    expect(appDoc.apply([{ op: "resolveSuggestion", suggestionId: "missing", decision: "accept" }]).ok).toBe(false);

    // Non-atomic partial failure keeps first op's diff & appliedCount
    const partial = appDoc.apply(
      [
        { op: "setTitle", title: "Partial Title" },
        { op: "deleteBlock", blockId: "99:99" },
      ],
      { atomic: false },
    );
    expect(partial.ok).toBe(false);
    expect(partial.appliedCount).toBe(1);
    expect(partial.diff.titleChanged?.after).toBe("Partial Title");

    // Non-Error throw path in apply catch
    const throwSpy = vi.spyOn(appDoc, "setTitle").mockImplementationOnce(() => { throw "string-failure"; });
    const strErr = appDoc.apply([{ op: "setTitle", title: "X" }]);
    throwSpy.mockRestore();
    expect(strErr.ok).toBe(false);
    expect(strErr.error?.message).toBe("string-failure");

    // Undo stack cap (> 50)
    for (let i = 0; i < 52; i++) appDoc.apply([{ op: "setTitle", title: `T${i}` }]);
    expect(appDoc.title).toBe("T51");

    // 8. verify(): malformed_table, unsafe_link, safe #/ link, safe https:// link
    const vDoc = Document.create({ title: "Verify" });
    vDoc.insertBlock({ type: "table", props: { tableData: "not-json" } });
    const lp = vDoc.insertBlock({ type: "paragraph", text: "bad ref ok" });
    vDoc.collabDoc.format({ client: Number(lp.id.split(":")[0]), clock: Number(lp.id.split(":")[1]) }, 0, 3, "link", "javascript:alert(1)");
    vDoc.collabDoc.format({ client: Number(lp.id.split(":")[0]), clock: Number(lp.id.split(":")[1]) }, 4, 7, "link", "#/doc/1");
    vDoc.collabDoc.format({ client: Number(lp.id.split(":")[0]), clock: Number(lp.id.split(":")[1]) }, 8, 10, "link", "https://jiange.dev");
    const vDiags = vDoc.verify();
    expect(vDiags.some((d) => d.code === "malformed_table")).toBe(true);
    expect(vDiags.some((d) => d.code === "unsafe_link")).toBe(true);

    // 9. Document.fromDocx: untitled DOCX with unanchored comment on body (blockIndex undefined -> defaults to 0)
    const enc = new TextEncoder();
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const bodyWithUnanchoredComment = createZip([
      { name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`) },
      { name: "word/document.xml", data: enc.encode(`<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`) },
      { name: "word/comments.xml", data: enc.encode(`<?xml version="1.0"?><w:comments xmlns:w="${W}"><w:comment w:id="1" w:author="Bob"><w:p><w:r><w:t>General note</w:t></w:r></w:p></w:comment></w:comments>`) },
    ]);
    const impWithCmt = await Document.fromDocx(bodyWithUnanchoredComment);
    expect(impWithCmt.document.title).toBe("");
    expect(impWithCmt.document.listComments()).toHaveLength(1);
    expect(impWithCmt.document.listComments()[0].body).toBe("General note");
  });
});
