import { describe, expect, it } from "vitest";
import { editorClipboardRoute, isNativeControl } from "./nativeControl";

// Model closest() across the same ancestor relationships used by an input,
// a table's action button, and an editable document/column text node.
function element(tag: string, parent?: EventTarget): EventTarget {
  return {
    closest(selector: string) {
      const tags = selector.split(",").map((part) => part.trim().toLowerCase());
      if (tags.includes(tag)) return this;
      return parent && typeof (parent as Element).closest === "function"
        ? (parent as Element).closest(selector)
        : null;
    },
  } as unknown as EventTarget;
}

describe("nested native controls in the document editor", () => {
  const editor = element("div");
  const column = element("div", editor);
  const table = element("table", editor);
  const cellInput = element("input", table);
  const actionIcon = element("svg", element("button", table));

  it("routes cell input and table controls to their native event handling, not the document selection", () => {
    expect(isNativeControl(cellInput)).toBe(true);
    expect(isNativeControl(actionIcon)).toBe(true);
    expect(isNativeControl(column)).toBe(false);
    expect(isNativeControl(editor)).toBe(false);
    expect(isNativeControl(null)).toBe(false);
  });

  it("preserves native cell copy and cut only when document copying is allowed", () => {
    expect(editorClipboardRoute(cellInput, false)).toBe("native");
    expect(editorClipboardRoute(cellInput, true)).toBe("block");
    expect(editorClipboardRoute(column, false)).toBe("editor");
    expect(editorClipboardRoute(column, true)).toBe("block");
  });
});
