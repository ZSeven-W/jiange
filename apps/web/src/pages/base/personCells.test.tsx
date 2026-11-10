import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BaseRecord, Field, User } from "@/lib/api";
import { CellEditor, CellView } from "./cells";

const members: User[] = [
  { id: 7, name: "张三", email: "", createdAt: "" },
  { id: 9, name: "李四", email: "", createdAt: "" },
  { id: 11, name: "王五", email: "", createdAt: "" },
];
const multi: Field = { id: 1, name: "成员", type: "person", position: 1, multiple: true };
const single: Field = { id: 1, name: "负责人", type: "person", position: 1 };
const record: BaseRecord = { id: 1, baseId: 1, position: 1, cells: { 1: [7, 9, 11] } };

describe("multi-person cells (允许多选)", () => {
  it("renders every member in full mode and the first plus a count in compact mode", () => {
    const full = renderToStaticMarkup(<CellView field={multi} record={record} members={members} canEdit={false} />);
    expect(full).toContain("张三");
    expect(full).toContain("李四");
    expect(full).toContain("王五");
    const compact = renderToStaticMarkup(<CellView field={multi} record={record} members={members} canEdit={false} compact />);
    expect(compact).toContain('title="张三、李四、王五"');
    expect(compact).toContain('aria-label="还有 2 项"');
    expect(compact).toContain("张三");
    expect(compact).not.toContain(">李四</span>");
  });

  it("keeps the scalar single-mode rendering and falls back to a member id label", () => {
    const markup = renderToStaticMarkup(<CellView field={single} record={{ ...record, cells: { 1: 9 } }} members={members} canEdit={false} />);
    expect(markup).toContain("李四");
    const unknown = renderToStaticMarkup(<CellView field={single} record={{ ...record, cells: { 1: [3, 4] } }} members={members} canEdit={false} />);
    expect(unknown).toContain("成员 #3");
  });

  it("uses the multi member editor with current selections checked", () => {
    const markup = renderToStaticMarkup(<CellEditor field={multi} record={record} members={members} onCommit={() => {}} onCancel={() => {}} />);
    expect(markup).toContain("data-person-editor");
    expect((markup.match(/checked/g) ?? []).length).toBe(3);
    expect(markup).toContain("确定");
  });

  it("keeps the native single select for single-mode and created_by fields", () => {
    const markup = renderToStaticMarkup(<CellEditor field={single} record={{ ...record, cells: { 1: 9 } }} members={members} onCommit={() => {}} onCancel={() => {}} />);
    expect(markup).toContain("<select");
    expect(markup).not.toContain("data-person-editor");
    const creator: Field = { id: 2, name: "创建人", type: "created_by", position: 2 };
    const createdMarkup = renderToStaticMarkup(<CellEditor field={creator} record={record} members={members} onCommit={() => {}} onCancel={() => {}} />);
    expect(createdMarkup).toContain("<select");
  });
});
