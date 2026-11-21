import { describe, expect, it } from "vitest";
import { markdownTableRows, parseInline, parseMarkdown, serializeInline, toMarkdown, viewToMarkdown, type MdSpan } from "../src/markdown.js";
import { tableHash } from "../src/table-cells.js";

const SAMPLE = `# 发布计划

Jiange **v0.1** 即将发布，重点看 \`性能\` 和 [文档](https://jiange.dev)。

## 功能列表

- 多维表格
  - 看板视图
  - 表格视图（*虚拟滚动*）
- [x] 实时协同
- [ ] 评论通知

### 备注

> 数据完全掌握在自己手里。

\`\`\`go
fmt.Println("jiange")
\`\`\`

---

![logo](https://x.dev/logo.png)
[需求文档](https://x.dev/spec.md)

\\#这不是标题 \\-也不是列表 1. 更不是有序列表
`;

describe("markdown inline marks", () => {
  it("imports internal markdown links as ordinary text links", () => {
    for (const url of ["#/doc/12", "#/s/token", "#/p/token"]) {
      const md = `[文字](${url})`;
      expect(parseInline(md)).toEqual([{ text: "文字", marks: { link: url, linkKind: "text" } }]);
      expect(serializeInline(parseInline(md))).toBe(md);
    }
  });
  it("parses bold/italic/strike/code/link and combinations", () => {
    const spans = parseInline("**粗** *斜* ~~删~~ `码` [文字](https://a.b) ***粗斜***");
    expect(spans).toEqual([
      { text: "粗", marks: { bold: "1" } },
      { text: " ", marks: {} },
      { text: "斜", marks: { italic: "1" } },
      { text: " ", marks: {} },
      { text: "删", marks: { strike: "1" } },
      { text: " ", marks: {} },
      { text: "码", marks: { code: "1" } },
      { text: " ", marks: {} },
      { text: "文字", marks: { link: "https://a.b" } },
      { text: " ", marks: {} },
      { text: "粗斜", marks: { bold: "1", italic: "1" } },
    ]);
  });
  it("serializes spans back to the same markdown", () => {
    const md = "**粗** *斜* ~~删~~ `码` [文字](https://a.b)";
    expect(serializeInline(parseInline(md))).toBe(md);
  });
});

describe("markdown blocks", () => {
  it("parses headings, lists, todo, quote, code, divider, image and standard links", () => {
    const blocks = parseMarkdown(SAMPLE);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual([
      "h1", "paragraph", "h2", "bullet", "bullet", "bullet", "todo", "todo",
      "h3", "quote", "code", "divider", "image", "paragraph", "paragraph",
    ]);
    const nested = blocks.find((b) => b.text === "看板视图")!;
    expect(nested.props.indent).toBe("1");
    const done = blocks.find((b) => b.type === "todo" && b.text === "实时协同")!;
    expect(done.props.checked).toBe("true");
    const code = blocks.find((b) => b.type === "code")!;
    expect(code.text).toBe('fmt.Println("jiange")');
    expect(code.props.lang).toBe("go");
    expect(blocks.find((b) => b.type === "image")!.props.url).toBe("https://x.dev/logo.png");
    expect(blocks.find((b) => b.type === "paragraph")!.spans.some((s) => s.marks.bold)).toBe(true);
  });

  it("md → blocks → md is idempotent", () => {
    const round1 = toMarkdown(parseMarkdown(SAMPLE));
    const round2 = toMarkdown(parseMarkdown(round1));
    expect(round1).toBe(round2);
    expect(round1).toContain("- [x] 实时协同");
    expect(round1).toContain("  - 看板视图");
    expect(round1).toContain("```go");
    expect(round1).toContain("\\#这不是标题");
  });

  it("consecutive ordered items renumber from 1", () => {
    const md = "1. 一\n2. 二\n3. 三\n\n段落\n\n5. 又一个";
    const out = toMarkdown(parseMarkdown(md));
    expect(out).toContain("1. 一");
    expect(out).toContain("2. 二");
    expect(out).toContain("3. 三");
    expect(out).toContain("1. 又一个");
    expect(toMarkdown(parseMarkdown(out))).toBe(out);
  });

  it("keeps literal Markdown syntax and backslashes as ordinary paragraph text", () => {
    const texts = ["# 标题", "- 列表", "1. 项目", "**重要**", "[文字](https://a.b)", "a `b` c", "\\# 标题", "---", "![图](https://a.b)", "$$x$$", "中文 😀"];
    const blocks = texts.map(text => ({ type: "paragraph", text, props: {}, spans: [{ text, marks: {} }] }));
    expect(parseMarkdown(toMarkdown(blocks)).map(b => [b.type, b.text, b.spans])).toEqual(
      texts.map(text => ["paragraph", text, [{ text, marks: {} }]]),
    );
  });

  it("preserves nested marks, literal punctuation, and escaped URL parentheses", () => {
    const marks = { bold: "1", italic: "1", strike: "1", link: "https://example.com/a(b)" };
    const spans: MdSpan[] = [{ text: "重要 *[中文]\\*", marks }, { text: " = ", marks: {} }, { text: "a`b", marks: { code: "1" } }];
    expect(parseInline(serializeInline(spans))).toEqual(spans);
  });

  it("separates adjacent marks and preserves backslashes in linked code", () => {
    const spans: MdSpan[] = [
      { text: "甲", marks: { bold: "1" } },
      { text: "乙", marks: { bold: "1", italic: "1" } },
      { text: "丙", marks: { italic: "1" } },
      { text: "]\\", marks: { code: "1", link: "https://x.dev" } },
      { text: "**~~`", marks: { code: "1", bold: "1", strike: "1" } },
    ];
    expect(parseInline(serializeInline(spans))).toEqual(spans);
  });

  it("handles long malformed link labels without repeatedly scanning the line", () => {
    for (const input of ["[".repeat(100_000), "[".repeat(100_000) + "](unclosed"]) {
      expect(parseInline(input)).toEqual([{ text: input, marks: {} }]);
    }
  }, 2000);

  it("chooses code and diagram fences longer than the source fences", () => {
    const blocks = ["code", "diagram"].map(type => ({ type, text: "示例\n```\n````\n结束", props: {}, spans: [] }));
    expect(parseMarkdown(toMarkdown(blocks))).toEqual(blocks);
  });

  it("recognizes fenced language tags containing punctuation", () => {
    const blocks = parseMarkdown("```c++\nint x;\n```\n```c#\nint y;\n```\n正文");
    expect(blocks.map(b => [b.type, b.text, b.props.lang])).toEqual([
      ["code", "int x;", "c++"], ["code", "int y;", "c#"], ["paragraph", "正文", undefined],
    ]);
    expect(parseMarkdown(toMarkdown(blocks))).toEqual(blocks);
  });

  it("preserves empty formulas and whitespace in single- and multi-line formulas", () => {
    const texts = ["", " x ", " \n x + y \n ", "x\n"];
    const blocks = texts.map(text => ({ type: "math", text, props: {}, spans: [] }));
    expect(parseMarkdown(toMarkdown(blocks))).toEqual(blocks);
  });

  it("exports and reimports table cells without losing punctuation, whitespace, or literal HTML", () => {
    const rows = [
      ["名称", "内容", "备注"],
      ["管道 | 反斜线 \\" , " *literal* [link] `code` ", "<br> &lt; &amp;"],
      ["行一\n行二", "\t制表\r回车", "😀"],
      ["", "  ", "结尾\\|"],
      ["\u00a0", "\u3000全角空格\u3000", "\v\f\ufeff边界\ufeff\f\v"],
    ];
    const view = { blocks: [{ type: "table", props: { tableData: JSON.stringify(rows) }, spans: [] }] };
    const markdown = viewToMarkdown(view);
    expect(markdown).toContain("| 名称 | 内容 | 备注 |");
    expect(markdown).toContain("| --- | --- | --- |");
    const [table] = parseMarkdown(markdown);
    expect(table.type).toBe("table");
    expect(JSON.parse(table.props.tableData)).toEqual(rows);
    expect(toMarkdown(parseMarkdown(markdown))).toBe(markdown);
  });

  it("imports standard tables while retaining literal cell source and neighboring paragraphs", () => {
    const markdown = "前文\n\n| 项目 | 负责人 |\n| :--- | ---: |\n| 界面 \\| 验证 | **小简** |\n\n后文 | 不属于表格\n";
    const blocks = parseMarkdown(markdown);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "table", "paragraph"]);
    expect(JSON.parse(blocks[1].props.tableData)).toEqual([["项目", "负责人"], ["界面 | 验证", "**小简**"]]);
    const out = toMarkdown(blocks);
    expect(parseMarkdown(out).map((block) => block.type)).toEqual(["paragraph", "table", "paragraph"]);
    expect(parseMarkdown(out)[2].text).toBe("后文 | 不属于表格");
  });

  it("keeps extra input cells as a following paragraph rather than discarding them", () => {
    const blocks = parseMarkdown("| a | b |\n| --- | --- |\n| c | d | e |\n");
    expect(blocks.map((block) => block.type)).toEqual(["table", "paragraph"]);
    expect(blocks[1].text).toContain("e");
  });

  it("does not turn ordinary neighboring text or fenced code into a table", () => {
    const texts = ["a | b", "--- | ---", "data | test"];
    const blocks = texts.map((text) => ({ type: "paragraph", text, props: {}, spans: [{ text, marks: {} }] }));
    expect(parseMarkdown(toMarkdown(blocks))).toEqual(blocks);
    const code = parseMarkdown("```x|y\n--- | ---\n```\n");
    expect(code).toEqual([{ type: "code", text: "--- | ---", props: { lang: "x|y" }, spans: [] }]);
    const heading = parseMarkdown("# a | b\n--- | ---\n");
    expect(heading.map((block) => block.type)).toEqual(["h1", "paragraph"]);
  });

  it("round-trips single-column and single-row tables", () => {
    for (const rows of [[["列一"], ["一 | 二"], [""]], [["唯一单元格"]]]) {
      const block = { type: "table", text: "", props: { tableData: JSON.stringify(rows) }, spans: [] };
      expect(parseMarkdown(toMarkdown([block]))).toEqual([block]);
    }
  });

  it("distinguishes escaped literal tags and entities from Markdown line breaks", () => {
    const [table] = parseMarkdown("| 值 |\n| --- |\n| \\<br> \\&amp; &#x1f600; <br>换行 |\n");
    expect(JSON.parse(table.props.tableData)).toEqual([["值"], ["<br> &amp; 😀 \n换行"]]);
  });

  it("retains malformed table source in an explicitly non-table code block", () => {
    const source = '{"bad":"保留"}';
    const markdown = toMarkdown([{ type: "table", text: "", props: { tableData: source }, spans: [] }]);
    expect(parseMarkdown(markdown)[0]).toMatchObject({ type: "code", text: source, props: { lang: "json" } });
  });

  it("exports flowchart and mindmap blocks to Mermaid without depending on whiteboard-sdk", () => {
    const props = {
      "fc.n.a": JSON.stringify({ shape: "terminator", text: "开始", z: 1 }),
      "fc.n.b": JSON.stringify({ shape: "diamond", text: "通过?", z: 2 }),
      "fc.e.e1": JSON.stringify({ from: "a", to: "b", label: "进入", dashed: true }),
      "fc.e.dangling": JSON.stringify({ from: "a", to: "missing" }),
      "fc.m.r": JSON.stringify({ parent: null, text: "中心主题", order: 1 }),
      "fc.m.c": JSON.stringify({ parent: "r", text: "分支", order: 2 }),
      "fc.n.bad": "{broken",
    };
    const md = toMarkdown([{ type: "flowchart", text: "", props, spans: [] }]);
    expect(md).toContain("```mermaid");
    expect(md).toContain('N1(["开始"])');
    expect(md).toContain('N2{"通过?"}');
    expect(md).toContain('N1 -.->|"进入"| N2');
    expect(md).toContain('M1["中心主题"]');
    expect(md).toContain("M1 --- M2");
    expect(md).not.toContain("missing");

    const custom = viewToMarkdown(
      { blocks: [{ type: "flowchart", props, spans: [] }] },
      { renderFlowchart: () => "graph LR\n  A --> B" },
    );
    expect(custom).toContain("graph LR\n  A --> B");
  });

  it("covers all flowchart shapes/arrows/defaults, inline edge cases, rich table cells, math, file, embed, and reminder", () => {
    // Flowchart edge cases: empty value, non-object JSON, missing fields, unknown shape, image shape, same z/order tie-break, all arrow/dashed/label combos
    const fcProps: Record<string, string> = {
      "fc.n.emptyVal": "",
      "fc.n.nonObj": "42",
      "fc.n.nullVal": "null",
      "fc.n.a": JSON.stringify({}),
      "fc.n.b": JSON.stringify({ shape: "customShape", text: "", z: 0 }),
      "fc.n.img": JSON.stringify({ shape: "image", text: "" }),
      "fc.m.m2": JSON.stringify({}),
      "fc.m.m1": JSON.stringify({ parent: "m2" }),
      "fc.e.e1": JSON.stringify({ from: "a", to: "b", arrow: "none", dashed: true }),
      "fc.e.e2": JSON.stringify({ from: "a", to: "b", arrow: "none", dashed: false }),
      "fc.e.e3": JSON.stringify({ from: "a", to: "b", arrow: "both", dashed: true }),
      "fc.e.e4": JSON.stringify({ from: "a", to: "b", arrow: "both", dashed: false }),
      "fc.e.e5": JSON.stringify({ from: "a", to: "b", dashed: false }),
    };
    const fcMd = toMarkdown([{ type: "flowchart", text: "", props: fcProps, spans: [] }]);
    expect(fcMd).toContain('"图片"');
    expect(fcMd).toContain("-.-");
    expect(fcMd).toContain("---");
    expect(fcMd).toContain("<-.->");
    expect(fcMd).toContain("<-->");
    expect(fcMd).toContain("-->");

    // Inline edge cases: unclosed delimiter (-1), empty delimiter (****), balanced parens in URL, empty/space URL in link, adjacent same marks via nested bold
    expect(parseInline("****")).toEqual([{ text: "****", marks: {} }]);
    expect(parseInline("*unclosed")).toEqual([{ text: "*unclosed", marks: {} }]);
    expect(parseInline("**a __b__**")).toEqual([{ text: "a b", marks: { bold: "1" } }]);
    const inlineMd = parseMarkdown(
      "[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) and [bad]() and [bad2](a b) and [a [b](x y)",
    );
    expect(inlineMd[0].spans.some((s) => s.marks.link === "https://en.wikipedia.org/wiki/Foo_(bar)")).toBe(true);

    // Code span padding edge cases in serializeInline (" a " padded, "   " not padded, " a" not padded)
    const codeSerialized = toMarkdown([
      {
        type: "paragraph",
        text: "",
        props: {},
        spans: [
          { text: " a ", marks: { code: "1" } },
          { text: "   ", marks: { code: "1" } },
          { text: " a", marks: { code: "1" } },
        ],
      },
    ]);
    expect(codeSerialized).toContain("`  a  `");

    // Table edge cases: markdownTableRows undefined/empty/ragged/non-string, invalid codepoint entity in table cell, short body row padding, rich table cell marks
    const shortRowAndSurrogate = parseMarkdown("| A | B |\n| --- | --- |\n| &#xD800; &#9999999; |\n");
    expect(JSON.parse(shortRowAndSurrogate[0].props.tableData)).toEqual([["A", "B"], ["&#xD800; &#9999999;", ""]]);

    const richTableProps: Record<string, string> = {
      "tbl.v": "2",
      "tbl.rows": '["r0","r1"]',
      "tbl.cols": '["c0"]',
      "tbl.c.r0.c0": "Header",
      "tbl.c.r1.c0": "PlainRich",
      "tbl.fmt.r1.c0": JSON.stringify([
        { text: "Plain" },
        { text: "Rich", marks: { code: true, strike: true, italic: true, bold: true, underline: true } },
      ]),
      tableData: '[["Header"],["PlainRich"]]',
    };
    richTableProps["tbl.m"] = tableHash(richTableProps.tableData);
    const richTableMd = toMarkdown([{ type: "table", text: "", props: richTableProps, spans: [] }]);
    expect(richTableMd).toContain("Plain<u>***~~`Rich`~~***</u>");

    // Multiline math starting with content on opening $$ line + anonymous image
    const mathAndImg = parseMarkdown("$$a + b\nc + d\n$$\n\n![](https://example.com/x.png)\n");
    expect(mathAndImg[0]).toMatchObject({ type: "math", text: "a + b\nc + d" });
    expect(mathAndImg[1]).toMatchObject({ type: "image", props: { url: "https://example.com/x.png", name: "图片" } });

    // markdownTableRows defaults and invalid shapes + file, embed, reminder, and fallback image serialization
    expect(markdownTableRows(undefined)).toEqual([["列 1", "列 2", "列 3"], ["", "", ""]]);
    expect(markdownTableRows("")).toEqual([["列 1", "列 2", "列 3"], ["", "", ""]]);
    expect(markdownTableRows('[["a"],["b","c"]]')).toBeNull();
    expect(markdownTableRows('[["a"],[1]]')).toBeNull();

    const miscMd = toMarkdown([
      { type: "image", text: "", props: {}, spans: [] },
      { type: "file", text: "doc.pdf", props: { name: "Report.pdf", url: "https://a.test/r.pdf" }, spans: [] },
      { type: "file", text: "fallback-name", props: {}, spans: [] },
      { type: "file", text: "", props: {}, spans: [] },
      { type: "embed", text: "", props: { resourceKind: "sheet", resourceId: "s1", title: "Budget" }, spans: [] },
      { type: "embed", text: "", props: { resourceKind: "base", resourceId: "b1" }, spans: [] },
      { type: "embed", text: "", props: { resourceKind: "survey", resourceId: "q1" }, spans: [] },
      { type: "embed", text: "", props: { resourceKind: "slides", resourceId: "p1" }, spans: [] },
      { type: "embed", text: "", props: {}, spans: [] },
      { type: "reminder", text: "", props: { date: "2026-11-21", time: "09:00", label: "Standup", done: "true" }, spans: [] },
      { type: "reminder", text: "", props: {}, spans: [] },
    ]);
    expect(miscMd).toContain("![图片]()");
    expect(miscMd).toContain("[Report.pdf](https://a.test/r.pdf)");
    expect(miscMd).toContain("[fallback-name]()");
    expect(miscMd).toContain("[附件]()");
    expect(miscMd).toContain("[嵌入电子表格：Budget](#/sheet/s1)");
    expect(miscMd).toContain("[嵌入多维表格：#b1](#/base/b1)");
    expect(miscMd).toContain("[嵌入问卷：#q1](#/survey/q1)");
    expect(miscMd).toContain("[嵌入幻灯片：#p1](#/slides/p1)");
    expect(miscMd).toContain("[嵌入资源：资源]");
    expect(miscMd).toContain("- [x] ⏰ 2026-11-21 09:00 Standup");
    expect(miscMd).toContain("- [ ] ⏰ 日期提醒");
  });
});
