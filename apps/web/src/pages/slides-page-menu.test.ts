import { describe, expect, it } from "vitest";
import { slidePageMenuPosition } from "./slides-page-menu";

describe("slide page menu positioning", () => {
  it("keeps a menu near its anchor and inside the viewport", () => {
    expect(slidePageMenuPosition(100, 150, 1280, 720)).toEqual({ left: 100, top: 150, width: 188, maxHeight: 562 });
    expect(slidePageMenuPosition(1275, 715, 1280, 720)).toEqual({ left: 1084, top: 460, width: 188, maxHeight: 252 });
  });
  it("allows scrolling on a short or narrow screen", () => {
    expect(slidePageMenuPosition(350, 350, 180, 200)).toEqual({ left: 8, top: 8, width: 164, maxHeight: 184 });
  });
});
