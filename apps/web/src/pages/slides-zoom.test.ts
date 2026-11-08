import { describe, expect, it } from "vitest";
import { clampSlideZoom, fitSlideZoom, parseSlideZoom } from "./slides-zoom";

describe("slide zoom", () => {
  it("fits the slide using both width and height", () => {
    expect(fitSlideZoom(992, 572)).toBe(100);
    expect(fitSlideZoom(512, 900)).toBe(50);
    expect(fitSlideZoom(1400, 302)).toBe(50);
    expect(fitSlideZoom(0, 0)).toBe(100);
  });
  it("allows narrow viewports to fit while clamping explicit zoom", () => {
    expect(fitSlideZoom(200, 500)).toBe(17);
    expect(clampSlideZoom(1)).toBe(25);
    expect(clampSlideZoom(250)).toBe(200);
    expect(parseSlideZoom(" 75% ")).toBe(75);
    expect(parseSlideZoom("15")).toBe(25);
    expect(parseSlideZoom("abc")).toBeNull();
    expect(parseSlideZoom("1e3")).toBeNull();
  });
});
