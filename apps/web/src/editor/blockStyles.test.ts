import { describe, expect, it } from "vitest";
import { CALLOUT_COLORS, calloutStyle } from "./blockStyles";

describe("Feishu callout colors", () => {
  it("defaults to the orange highlight with a matching border", () => {
    expect(calloutStyle(undefined)).toEqual({ background: "#FEF1E1", borderColor: "#F9D7AF" });
    expect(calloutStyle("1")).toEqual({ background: CALLOUT_COLORS[1][0], borderColor: CALLOUT_COLORS[1][1] });
  });
  it("falls back to the default for unknown indexes", () => {
    expect(calloutStyle("99")).toEqual(calloutStyle("0"));
    expect(calloutStyle("x")).toEqual(calloutStyle("0"));
  });
});
