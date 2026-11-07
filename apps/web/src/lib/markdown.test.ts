import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, serializeInline, toMarkdown, viewToMarkdown, type MdSpan } from "./markdown";

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
});
