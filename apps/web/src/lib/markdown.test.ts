import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, serializeInline, toMarkdown } from "./markdown";

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
  it("parses headings, lists, todo, quote, code, divider, image and file", () => {
    const blocks = parseMarkdown(SAMPLE);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual([
      "h1", "paragraph", "h2", "bullet", "bullet", "bullet", "todo", "todo",
      "h3", "quote", "code", "divider", "image", "file", "paragraph",
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
});
