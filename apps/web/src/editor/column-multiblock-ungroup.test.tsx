import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, eqId, ROOT, Tx } from "@zseven-w/collab";
import { buildDocx } from "@zseven-w/doc-sdk/docx";
import { listZip, readZipEntry } from "@/lib/zip";
import { buildColumnUngroupOps } from "./column-ops-commit";
import { ColumnNestedBlocks } from "./column-nested-blocks";

describe("Multi-block columns, ungroup, and DOCX export", () => {
  it("ungroups a multi-block columns container while preserving column IDs and nested child blocks", () => {
    const doc = new Doc(7);
    const tx = new Tx(doc);
    const group = tx.create("columns", null, ROOT);
    const col1 = tx.create("paragraph", null, group);
    tx.insert(col1, 0, "左栏首段");
    const nestedH2 = tx.create("h2", null, col1);
    tx.insert(nestedH2, 0, "左栏标题");
    const nestedTodo = tx.create("todo", nestedH2, col1);
    tx.insert(nestedTodo, 0, "左栏待办");
    const col2 = tx.create("paragraph", col1, group);
    tx.insert(col2, 0, "右栏内容");

    const ops = buildColumnUngroupOps(doc, group);
    expect(ops).not.toBeNull();
    for (const op of ops!) doc.apply(op);

    const roots = doc.children(ROOT);
    expect(roots.some((id) => eqId(id, group))).toBe(false);
    expect(roots).toHaveLength(4);
    expect(eqId(roots[0], col1)).toBe(true);
    expect(eqId(roots[1], nestedH2)).toBe(true);
    expect(eqId(roots[2], nestedTodo)).toBe(true);
    expect(eqId(roots[3], col2)).toBe(true);
    expect(doc.text(col1)).toBe("左栏首段");
    expect(doc.text(nestedH2)).toBe("左栏标题");
    expect(doc.text(nestedTodo)).toBe("左栏待办");
    expect(doc.text(col2)).toBe("右栏内容");
  });

  it("ungroups a single remaining column cleanly", () => {
    const doc = new Doc(9);
    const tx = new Tx(doc);
    const group = tx.create("columns", null, ROOT);
    const onlyCol = tx.create("paragraph", null, group);
    tx.insert(onlyCol, 0, "最后一栏");

    const ops = buildColumnUngroupOps(doc, group);
    expect(ops).not.toBeNull();
    for (const op of ops!) doc.apply(op);

    const roots = doc.children(ROOT);
    expect(roots).toHaveLength(1);
    expect(eqId(roots[0], onlyCol)).toBe(true);
    expect(doc.text(onlyCol)).toBe("最后一栏");
  });

  it("renders multi-block nested children inside a column with add-block control", () => {
    const html = renderToStaticMarkup(
      <ColumnNestedBlocks
        columnId="1:2"
        canEdit={true}
        blocks={[
          { id: "1:3", type: "h2", props: {}, text: "小节标题" },
          { id: "1:4", type: "todo", props: { checked: "true" }, text: "已完成项" },
          { id: "1:5", type: "callout", props: { emoji: "💡" }, text: "高亮提示" },
          { id: "1:6", type: "divider", props: {}, text: "" },
        ]}
        onAddBlock={() => {}}
        onCommitText={() => {}}
        onToggleTodo={() => {}}
        onDeleteBlock={() => {}}
      />,
    );
    expect(html).toContain('data-column-child-block="1:3"');
    expect(html).toContain("小节标题");
    expect(html).toContain("已完成项");
    expect(html).toContain("高亮提示");
    expect(html).toContain('data-add-column-block="1:2"');
  });

  it("exports multi-block columns as a borderless Word table in DOCX", async () => {
    const bytes = buildDocx({
      blocks: [
        { id: "1:1", parent: "0:0", type: "columns", props: {}, spans: [] },
        { id: "1:2", parent: "1:1", type: "paragraph", props: {}, spans: [{ text: "第一栏正文", marks: {} }] },
        { id: "1:3", parent: "1:2", type: "h2", props: {}, spans: [{ text: "第一栏子标题", marks: {} }] },
        { id: "1:4", parent: "1:1", type: "paragraph", props: {}, spans: [{ text: "第二栏正文", marks: {} }] },
      ],
    });
    const entry = listZip(bytes).find((e) => e.name === "word/document.xml");
    expect(entry).toBeDefined();
    const xml = new TextDecoder().decode(await readZipEntry(bytes, entry!, 1024 * 1024));
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain('<w:top w:val="none"');
    expect(xml).toContain("第一栏正文");
    expect(xml).toContain("第一栏子标题");
    expect(xml).toContain("第二栏正文");
  });
});
