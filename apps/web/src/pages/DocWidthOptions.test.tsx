import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocWidthOptions } from "./DocWidthOptions";

describe("document width options", () => {
  it("shows three choices with a single accessible selected option", () => {
    const html = renderToStaticMarkup(<DocWidthOptions width="wider" onChange={() => {}} />);
    expect(html).toContain("为当前窗口选择合适页宽");
    for (const label of ["默认", "较宽", "全宽"]) expect(html).toContain(label);
    expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-checked="true" data-doc-width-option="wider"');
  });
});
