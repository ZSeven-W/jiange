import { describe, expect, it } from "vitest";
import type { Comment, User } from "@/lib/api";
import { mentionQuery, mentionsIn, splitMentions, threadComments } from "./recordComments";

const c = (id: number, parentId?: number): Comment => ({ id, docId: 1, userId: 1, userName: "Kay", parentId, block: "record:1", startChar: "", endChar: "", quote: "", body: "", resolved: false, createdAt: "", updatedAt: "" });
const members = [{ id: 1, name: "Kay" }, { id: 2, name: "Shen" }, { id: 3, name: "Shen Li" }] as User[];

describe("record comment threads", () => {
  it("groups replies under their root", () => {
    const t = threadComments([c(1), c(2, 1), c(3), c(4, 1)]);
    expect(t.map((x) => [x.root.id, x.replies.map((r) => r.id)])).toEqual([[1, [2, 4]], [3, []]]);
  });
  it("finds mentions and the @query at the caret", () => {
    expect(mentionsIn("@Shen 看一下", members)).toEqual([2]);
    expect(mentionQuery("你好 @Sh", 7)).toEqual({ start: 3, query: "Sh" });
    expect(mentionQuery("你好 @Shen 好", 10)).toBeNull();
  });
  it("renders the longest mentioned name as one chip", () => {
    expect(splitMentions("请 @Shen Li 确认", ["Shen", "Shen Li"])).toEqual([
      { text: "请 ", mention: false }, { text: "@Shen Li", mention: true }, { text: " 确认", mention: false },
    ]);
  });
});
