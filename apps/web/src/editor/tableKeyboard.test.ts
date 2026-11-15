import { describe, expect, it } from "vitest";
import { tableTabIntent } from "./tableKeyboard";

describe("table Tab navigation", () => {
  it("moves forward to the next visible cell and starts before its text", () => {
    expect(tableTabIntent(0, 3, false)).toEqual({ kind: "focus", index: 1, caret: "start" });
    expect(tableTabIntent(1, 3, false)).toEqual({ kind: "focus", index: 2, caret: "start" });
  });
  it("moves backward to the end and stays in the first cell", () => {
    expect(tableTabIntent(2, 3, true)).toEqual({ kind: "focus", index: 1, caret: "end" });
    expect(tableTabIntent(0, 3, true)).toEqual({ kind: "stay" });
  });
  it("appends after the last visible cell and refuses invalid positions", () => {
    expect(tableTabIntent(2, 3, false)).toEqual({ kind: "append" });
    expect(tableTabIntent(-1, 3, false)).toEqual({ kind: "stay" });
    expect(tableTabIntent(0, 0, false)).toEqual({ kind: "stay" });
  });
});
