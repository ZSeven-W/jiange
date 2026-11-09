import { describe, expect, it } from "vitest";
import { formatCommentTime } from "./CommentsPanel";

describe("comment card time", () => {
  const now = new Date(2026, 10, 9, 17, 0);
  it("formats like Feishu comment cards", () => {
    expect(formatCommentTime(new Date(2026, 10, 9, 16, 53).toISOString(), now)).toBe("今天 16:53");
    expect(formatCommentTime(new Date(2026, 10, 8, 9, 5).toISOString(), now)).toBe("11月8日 09:05");
    expect(formatCommentTime(new Date(2025, 0, 3, 9, 5).toISOString(), now)).toBe("2025年1月3日");
    expect(formatCommentTime("bad", now)).toBe("");
  });
});
