import { describe, expect, it } from "vitest";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeLineNumbers, codeLineStarts } from "./CodeLineNumbers";

describe("code block line numbers", () => {
  it("numbers every logical line, including a trailing empty one", () => {
    expect(codeLineStarts("")).toEqual([0]);
    expect(codeLineStarts("a\nbc\n")).toEqual([0, 2, 5]);
  });
  it("renders a non-editable gutter that falls back to stacked numbers without layout", () => {
    const html = renderToStaticMarkup(<CodeLineNumbers text={"x\ny\nz"} textRef={createRef<HTMLDivElement>()} wrap />);
    expect(html).toContain('data-code-lines="3"');
    expect(html).toContain('contentEditable="false"');
    expect(html).not.toContain("data-text");
    expect(html.replace(/<[^>]+>/g, "")).toBe("123");
  });
});
