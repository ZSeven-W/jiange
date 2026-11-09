import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CALLOUT_COLOR_NAMES, CALLOUT_EMOJIS, CalloutColorBar, CalloutEmoji } from "./CalloutControls";
import { CALLOUT_COLORS } from "./blockStyles";

describe("高亮块 emoji and color pickers", () => {
  it("opens an emoji grid marking the current icon", () => {
    const html = renderToStaticMarkup(<CalloutEmoji emoji="🔥" onPick={() => {}} initialOpen />);
    expect(html).toContain("data-callout-emoji-pop");
    expect(html.match(/data-callout-emoji-option=/g)).toHaveLength(CALLOUT_EMOJIS.length);
    expect(html).toMatch(/bg-primary\/10[^"]*"[^>]*data-callout-emoji-option="🔥"/);
  });
  it("is a static icon for readers", () => {
    const html = renderToStaticMarkup(<CalloutEmoji initialOpen />);
    expect(html).toContain("💡");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("data-callout-emoji-pop");
  });
  it("offers every callout color pair with names and marks the active one", () => {
    expect(CALLOUT_COLOR_NAMES).toHaveLength(CALLOUT_COLORS.length);
    const html = renderToStaticMarkup(<CalloutColorBar color="2" onPick={() => {}} />);
    expect(html.match(/data-callout-color-option=/g)).toHaveLength(CALLOUT_COLORS.length);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-callout-color-option="2"/);
    expect(html).toContain(`border-color:${CALLOUT_COLORS[1][1]}`);
    expect(new Set(CALLOUT_EMOJIS).size).toBe(CALLOUT_EMOJIS.length);
  });
});
