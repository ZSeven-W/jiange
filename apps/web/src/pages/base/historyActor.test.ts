import { describe, expect, it } from "vitest";
import { historyActorName, historyHeadline } from "./historyActor";
import type { RecordHistoryEntry, User } from "@/lib/api";

const members = [{ id: 1, name: "Kay", email: "" }, { id: 2, name: "Shen", email: "" }] as User[];
const e = (x: Partial<RecordHistoryEntry>): RecordHistoryEntry => ({ seq: 1, op: "update", changes: [], ...x });

describe("record history actor", () => {
  it("names users, forms and legacy events", () => {
    expect(historyHeadline(e({ actor: { kind: "user", id: 2, name: "Shen" } }), members)).toBe("Shen 修改了记录");
    expect(historyHeadline(e({ actor: { kind: "user", id: 1 } }), members)).toBe("Kay 修改了记录");
    expect(historyHeadline(e({ op: "add", actor: { kind: "form" } }), members)).toBe("表单提交 创建了记录");
    expect(historyHeadline(e({}), members)).toBe("修改了记录");
    expect(historyHeadline(e({ op: "add", by: 1 }), members)).toBe("Kay 创建了记录");
    expect(historyActorName(e({ actor: { kind: "user", id: 9 } }), members)).toBe("已移除的成员");
  });
});
