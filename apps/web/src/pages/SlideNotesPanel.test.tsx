import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { clampNotesHeight, notesHeightLimit, SlideNotesPanel } from "./SlideNotesPanel";

describe("slide notes panel", () => {
  it("reserves space for the slide in short and large viewports", () => {
    expect(notesHeightLimit(220)).toBe(72);
    expect(notesHeightLimit(500)).toBe(232);
    expect(notesHeightLimit(1200)).toBe(420);
    expect(clampNotesHeight(20, 232)).toBe(72);
    expect(clampNotesHeight(350, 232)).toBe(232);
  });
  it("exposes a keyboard-accessible separator and a read-only notes field", () => {
    const html = renderToStaticMarkup(<SlideNotesPanel value="演讲提示" readOnly onChange={() => {}} onBlur={() => {}}/>);
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="调整备注区高度"');
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('readOnly=""');
    expect(html).toContain("演讲提示");
  });
});
