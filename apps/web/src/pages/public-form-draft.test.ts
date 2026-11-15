import { describe, expect, it } from "vitest";
import { clearPublicFormDraft, readPublicFormDraft, writePublicFormDraft } from "./public-form-draft";

function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
const fields = [{ id: 1, name: "姓名", type: "text" }, { id: 2, name: "数量", type: "number" }, { id: 3, name: "确认", type: "checkbox" }, { id: 4, name: "方式", type: "select", options: ["线上", "线下"] }, { id: 5, name: "关注", type: "multi_select", options: ["设计", "开发"] }];

describe("public form drafts", () => {
  it("restores typed answers and clears only the requested draft", () => {
    const s = storage(), values = { 1: "测试", 2: "0", 3: false, 4: "线上", 5: ["设计"] };
    s.setItem("hash-a", "1");
    expect(writePublicFormDraft(s, "hash-a", fields, values, [])).toBe(true);
    expect(writePublicFormDraft(s, "hash-b", fields, { 1: "其他" }, [])).toBe(true);
    expect(readPublicFormDraft(s, "hash-a", fields)).toEqual({ values, unmatched: [], unreadable: null });
    expect(clearPublicFormDraft(s, "hash-a")).toBe(true);
    expect(s.getItem("hash-a")).toBe("1");
    expect(readPublicFormDraft(s, "hash-b", fields).values).toEqual({ 1: "其他" });
  });
  it("preserves changed or removed questions without assigning their answers to a different question", () => {
    const s = storage();
    writePublicFormDraft(s, "hash", fields, { 1: "原姓名", 4: "线上", 5: ["开发"] }, []);
    const revised = [{ ...fields[0], name: "昵称" }, { ...fields[3], options: ["线下"] }];
    const restored = readPublicFormDraft(s, "hash", revised);
    expect(restored.values).toEqual({});
    expect(restored.unmatched.map((entry) => entry.value)).toEqual(["原姓名", "线上", ["开发"]]);
    expect(writePublicFormDraft(s, "hash", revised, { 1: "新昵称" }, restored.unmatched)).toBe(true);
    const again = readPublicFormDraft(s, "hash", revised);
    expect(again.values).toEqual({ 1: "新昵称" });
    expect(again.unmatched).toEqual(restored.unmatched);
  });
  it("does not interpret corrupt or unsupported drafts as valid data", () => {
    const s = storage(), key = "hash:draft:v1";
    for (const raw of ["{", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ id: 1, name: "姓名", type: "text", value: { bad: true } }] })]) {
      s.setItem(key, raw);
      expect(readPublicFormDraft(s, "hash", fields).unreadable).toBe(raw);
      expect(s.getItem(key)).toBe(raw);
    }
    const denied = { getItem: () => { throw Error("denied"); }, setItem: () => { throw Error("denied"); }, removeItem: () => { throw Error("denied"); } };
    expect(readPublicFormDraft(denied, "hash", fields).unreadable).not.toBeNull();
    expect(writePublicFormDraft(denied, "hash", fields, { 1: "测试" }, [])).toBe(false);
    expect(clearPublicFormDraft(denied, "hash")).toBe(false);
  });
});
