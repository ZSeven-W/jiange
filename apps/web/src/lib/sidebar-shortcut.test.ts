import { describe, expect, it } from "vitest";
import { isDocumentSidebarShortcut } from "./sidebar-shortcut";

const event = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: "]", code: "BracketRight", metaKey: true, ctrlKey: false, altKey: false,
  shiftKey: false, isComposing: false, repeat: false, defaultPrevented: false,
  ...overrides,
});

describe("document navigation shortcut", () => {
  it("recognizes the Mac and Windows/Linux shortcut", () => {
    expect(isDocumentSidebarShortcut(event())).toBe(true);
    expect(isDocumentSidebarShortcut(event({ metaKey: false, ctrlKey: true }))).toBe(true);
    expect(isDocumentSidebarShortcut(event({ code: "", key: "]" }))).toBe(true);
  });

  it("leaves composing, repeated, intercepted and other modified keys alone", () => {
    for (const change of [
      { isComposing: true }, { repeat: true }, { defaultPrevented: true },
      { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: false },
      { code: "BracketLeft", key: "[" },
    ]) expect(isDocumentSidebarShortcut(event(change))).toBe(false);
  });
});
