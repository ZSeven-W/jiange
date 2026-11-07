import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CELL_UNKNOWN, runWriteBatch, sessionWriteLedger, WriteIssues, WriteLedger, WriteNotAttempted, type WriteAuthorization } from "./writeSafety";

const access = (): WriteAuthorization => ({
  base: { id: 1, workspaceId: 1, parentId: null, title: "表", icon: "", creatorId: 1, creatorName: "甲", createdAt: "", updatedAt: "", role: "edit" },
  fields: [{ id: 3, name: "数字", type: "number", position: 1 }],
  records: [{ id: 7, baseId: 1, position: 0, cells: { 3: 12 } }],
  views: [], expansions: {},
});

describe("table write safety", () => {
  it("keeps an unknown result and its original input until the user acknowledges it", () => {
    const ledger = new WriteLedger();
    ledger.setAuthorization(access());
    const id = ledger.begin("记录 #7 · 数字", "0012", "cell:7:3")!;
    expect(ledger.blocked("cell:7:3")).toBe(true);
    ledger.discard(id);
    expect(ledger.snapshot()).toHaveLength(1); // pending requests cannot be dismissed
    ledger.fail(id, CELL_UNKNOWN);
    expect(ledger.begin("再次编辑", "13", "cell:7:3")).toBeNull();
    const html = renderToStaticMarkup(<WriteIssues ledger={ledger} issues={ledger.snapshot()} />);
    expect(html).toContain("0012");
    expect(html).toContain("不会自动重试");
    ledger.discard(id);
    expect(ledger.blocked("cell:7:3")).toBe(false);
  });

  it("hides retained input when authorization or its projected row/field changes, without deleting it", () => {
    const ledger = new WriteLedger();
    const original = access();
    ledger.setAuthorization(original);
    const id = ledger.begin("记录 #7 · 数字", "隐私草稿", "cell:7:3")!;
    ledger.fail(id, CELL_UNKNOWN);
    const render = () => renderToStaticMarkup(<WriteIssues ledger={ledger} issues={ledger.snapshot()} />);
    expect(render()).toContain("隐私草稿");
    ledger.setAuthorization(null);
    expect(render()).not.toContain("隐私草稿");
    ledger.setAuthorization({ ...original, fields: [] });
    expect(render()).not.toContain("数字");
    ledger.setAuthorization({ ...original, records: [] });
    expect(render()).not.toContain("隐私草稿");
    ledger.setAuthorization({ ...original, records: [{ ...original.records[0], cells: {} }] });
    expect(render()).not.toContain("隐私草稿");
    ledger.setAuthorization({ ...original, base: { ...original.base, copyProtected: true } });
    expect(render()).not.toContain("隐私草稿");
    ledger.setAuthorization({ ...original, writeRestricted: true });
    expect(render()).not.toContain("隐私草稿");
    expect(ledger.snapshot()).toHaveLength(1);
    ledger.setAuthorization(access());
    expect(render()).toContain("隐私草稿");
  });

  it("hides a batch when an authorized row narrows and hides relation drafts when target expansion changes", () => {
    const ledger = new WriteLedger();
    const original: WriteAuthorization = { ...access(), fields: [{ id: 3, name: "关联", type: "link", position: 1 }], records: [{ id: 7, baseId: 1, position: 0, cells: { 3: [9] as unknown as string[] } }], expansions: { "3": { "7": [9] }, "3:titles": { "9": "目标秘密" } } };
    ledger.setAuthorization(original);
    const cell = ledger.begin("关联", "目标秘密", "cell:7:3")!;
    ledger.fail(cell, CELL_UNKNOWN);
    const batch = ledger.begin("清空", "目标秘密", "batch")!;
    ledger.fail(batch, CELL_UNKNOWN);
    const narrowed = { ...original, expansions: {} };
    ledger.setAuthorization(narrowed);
    expect(ledger.snapshot().every((issue) => !ledger.mayShow(issue))).toBe(true);
    expect(renderToStaticMarkup(<WriteIssues ledger={ledger} issues={ledger.snapshot()} />)).not.toContain("目标秘密");
    ledger.setAuthorization(original);
    expect(ledger.snapshot().every((issue) => ledger.mayShow(issue))).toBe(true);
  });

  it("retains a non-sensitive skip summary after partial writes change the projection", () => {
    const ledger = new WriteLedger();
    const original = access();
    ledger.setAuthorization(original);
    const id = ledger.begin("粘贴", "私密原 TSV", "batch")!;
    ledger.fail(id, "详情含原值", "有 1 个单元格未写入（第 1 行第 2 列）。");
    ledger.setAuthorization({ ...original, records: [{ ...original.records[0], cells: { 3: 99 } }] });
    const html = renderToStaticMarkup(<WriteIssues ledger={ledger} issues={ledger.snapshot()} />);
    expect(html).toContain("第 1 行第 2 列");
    expect(html).not.toContain("私密原 TSV");
    expect(html).not.toContain("详情含原值");
  });

  it("retains pasted input after partial writes while target rows and fields remain authorized", () => {
    const ledger = new WriteLedger();
    const original = access();
    ledger.setAuthorization(original);
    const scope = { kind: "paste" as const, recordIds: [7], fieldIds: [3] };
    const id = ledger.begin("粘贴", "自输 TSV", "batch", undefined, false, true, scope)!;
    ledger.fail(id, "部分未写入", "第 1 行第 2 列未写入。");
    ledger.setAuthorization({ ...original, records: [{ ...original.records[0], cells: { 3: 99 } }] });
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(true);
    expect(renderToStaticMarkup(<WriteIssues ledger={ledger} issues={ledger.snapshot()} />)).toContain("自输 TSV");
    ledger.setAuthorization({ ...original, records: [] });
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(false);
    ledger.setAuthorization({ ...original, fields: [] });
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(false);
  });

  it("hides pasted input if its related-field projection narrows", () => {
    const ledger = new WriteLedger();
    const original: WriteAuthorization = { ...access(), fields: [{ id: 3, name: "关联", type: "link", position: 1 }], records: [{ id: 7, baseId: 1, position: 0, cells: {} }], expansions: { "3": { "7": [9] }, "3:titles": { "9": "内部名称" } } };
    ledger.setAuthorization(original);
    const scope = { kind: "paste" as const, recordIds: [7], fieldIds: [3] };
    const id = ledger.begin("粘贴", "用户输入", undefined, undefined, false, true, scope)!;
    ledger.fail(id, "未写入");
    ledger.setAuthorization({ ...original, expansions: {} });
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(false);
  });

  it("binds a rejected user view name to view identity without requiring the old name", () => {
    const ledger = new WriteLedger();
    const original: WriteAuthorization = { ...access(), views: [{ id: 12, baseId: 1, type: "grid", name: "原视图", config: {}, pos: 0 }] };
    ledger.setAuthorization(original);
    const scope = { kind: "view" as const, viewId: 12 };
    const id = ledger.begin("重命名视图", "我的新名称", undefined, undefined, false, true, scope)!;
    ledger.fail(id, "名称未保存");
    ledger.setAuthorization({ ...original, views: [{ ...original.views[0], name: "协作者新名称" }] });
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(true);
    ledger.setAuthorization({ ...original, views: [] });
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(false);
    ledger.setAuthorization({ ...original, base: { ...original.base, role: "view" } });
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(false);
  });

  it("binds an unfinished edit to the authorization when editing began", () => {
    const ledger = new WriteLedger();
    const original = access();
    ledger.setAuthorization(original);
    const token = ledger.capture("cell:7:3");
    ledger.setAuthorization({ ...original, fields: [] });
    const id = ledger.begin("字段已隐藏", "未提交输入", "cell:7:3", token)!;
    ledger.fail(id, "未提交");
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(false);
    expect(renderToStaticMarkup(<WriteIssues ledger={ledger} issues={ledger.snapshot()} />)).not.toContain("未提交输入");
    ledger.setAuthorization(original);
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(true);
  });

  it("keeps typed scalar input visible after a lost response changes the server value", () => {
    const ledger = new WriteLedger();
    const original = access();
    ledger.setAuthorization(original);
    const id = ledger.begin("记录 #7 · 数字", "99", "cell:7:3", undefined, false, true)!;
    ledger.fail(id, CELL_UNKNOWN);
    ledger.setAuthorization({ ...original, records: [{ ...original.records[0], cells: { 3: 99 } }] });
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(true);
    expect(renderToStaticMarkup(<WriteIssues ledger={ledger} issues={ledger.snapshot()} />)).toContain("99");
    ledger.setAuthorization({ ...original, fields: [] });
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(false);
    ledger.setAuthorization({ ...original, records: [] });
    expect(ledger.mayShow(ledger.snapshot()[0])).toBe(false);
  });

  it("isolates pending and failed input by authenticated session and base", () => {
    const firstSession = {};
    const secondSession = {};
    const one = sessionWriteLedger(firstSession, 1);
    const id = one.begin("记录", "私有输入", "cell:2:3")!;
    one.fail(id, CELL_UNKNOWN);
    expect(sessionWriteLedger(firstSession, 1).snapshot()[0].draft).toBe("私有输入");
    expect(sessionWriteLedger(firstSession, 2).snapshot()).toEqual([]);
    expect(sessionWriteLedger(secondSession, 1).snapshot()).toEqual([]);
  });

  it("stops after a lost response without sending later non-idempotent rows", async () => {
    const sent: number[] = [];
    const result = await runWriteBatch([
      async () => { sent.push(1); },
      async () => { sent.push(2); throw new Error("connection lost"); },
      async () => { sent.push(3); },
    ]);
    expect(sent).toEqual([1, 2]);
    expect(result).toEqual({ confirmed: 1, attempted: 2, total: 3, complete: false });
  });

  it("reports a changed selection as not attempted before making another request", async () => {
    const sent: number[] = [];
    const result = await runWriteBatch([
      async () => { sent.push(1); },
      async () => { throw new WriteNotAttempted(); },
      async () => { sent.push(3); },
    ]);
    expect(sent).toEqual([1]);
    expect(result).toEqual({ confirmed: 1, attempted: 1, total: 3, complete: false });
  });

  it("notifies subscribers on pending, failure and explicit acknowledgement", () => {
    const ledger = new WriteLedger();
    const changed = vi.fn();
    const unsubscribe = ledger.subscribe(changed);
    const id = ledger.begin("粘贴", "甲\t乙", "batch")!;
    ledger.fail(id, "部分结果未知");
    ledger.discard(id);
    unsubscribe();
    ledger.begin("另一操作", "");
    expect(changed).toHaveBeenCalledTimes(3);
  });
});
