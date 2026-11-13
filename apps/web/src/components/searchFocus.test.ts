import { describe, expect, it, vi } from "vitest";
import { captureSearchFocus, restoreSearchFocus } from "./searchFocus";

function editableFixture() {
  const node = { textContent: "正文内容" } as unknown as Node;
  const range = { startContainer: node, startOffset: 2, endContainer: node, endOffset: 2, toString: () => "" };
  const selection = { rangeCount: 1, anchorNode: node, anchorOffset: 2, focusNode: node, focusOffset: 2, getRangeAt: () => range, setBaseAndExtent: vi.fn() };
  const recreated = { setStart: vi.fn(), setEnd: vi.fn(), toString: () => "" };
  const doc = { activeElement: null as HTMLElement | null, getSelection: () => selection, createRange: () => recreated, dispatchEvent: vi.fn() };
  const opener = { tagName: "DIV", isContentEditable: true, isConnected: true, ownerDocument: doc, closest: () => ({}), contains: (value: Node) => value === node, getClientRects: () => ({ length: 1 }), focus: vi.fn(() => { doc.activeElement = opener as unknown as HTMLElement; }) } as unknown as HTMLElement;
  return { node, opener, doc, selection, range, recreated };
}

describe("global search focus restoration", () => {
  it("restores the captured editing position and synchronizes the editor", () => {
    const { node, opener, doc, selection } = editableFixture();
    const snapshot = captureSearchFocus(opener, () => true)!;
    expect(restoreSearchFocus(snapshot)).toBe(true);
    expect(selection.setBaseAndExtent).toHaveBeenCalledWith(node, 2, node, 2);
    expect(doc.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "selectionchange" }));
  });

  it("does not focus a stale editor after document or selection changes", () => {
    const { node, opener } = editableFixture();
    expect(restoreSearchFocus(captureSearchFocus(opener, () => false)!)).toBe(false);
    expect(restoreSearchFocus(captureSearchFocus(opener, null)!)).toBe(false);
    expect(restoreSearchFocus(captureSearchFocus(opener, () => { throw new Error("unavailable"); })!)).toBe(false);
    const snapshot = captureSearchFocus(opener, () => true)!;
    node.textContent = "远程修改";
    expect(restoreSearchFocus(snapshot)).toBe(false);
    expect(opener.focus).not.toHaveBeenCalled();
  });

  it("restores a backward selection with its original direction", () => {
    const { node, opener, selection, range } = editableFixture();
    selection.anchorOffset = 4; selection.focusOffset = 1;
    range.startOffset = 1; range.endOffset = 4;
    const snapshot = captureSearchFocus(opener, () => true)!;
    expect(restoreSearchFocus(snapshot)).toBe(true);
    expect(selection.setBaseAndExtent).toHaveBeenCalledWith(node, 4, node, 1);
  });

  it("restores a textarea caret only while its contents remain unchanged", () => {
    const doc = { activeElement: null as HTMLElement | null };
    const input = { tagName: "TEXTAREA", isContentEditable: false, isConnected: true, ownerDocument: doc, closest: () => ({}), getClientRects: () => ({ length: 1 }), readOnly: false, disabled: false, value: "原文", selectionStart: 1, selectionEnd: 1, selectionDirection: "none", focus: vi.fn(() => { doc.activeElement = input as unknown as HTMLElement; }), setSelectionRange: vi.fn() } as unknown as HTMLTextAreaElement;
    const snapshot = captureSearchFocus(input, () => true)!;
    expect(restoreSearchFocus(snapshot)).toBe(true);
    expect(input.setSelectionRange).toHaveBeenCalledWith(1, 1, "none");
  });

  it("does not restore a changed textarea selection", () => {
    const doc = { activeElement: null as HTMLElement | null };
    const input = { tagName: "TEXTAREA", isContentEditable: false, isConnected: true, ownerDocument: doc, closest: () => ({}), getClientRects: () => ({ length: 1 }), readOnly: false, disabled: false, value: "原文", selectionStart: 1, selectionEnd: 1, selectionDirection: "none", focus: vi.fn(), setSelectionRange: vi.fn() } as unknown as HTMLTextAreaElement;
    const snapshot = captureSearchFocus(input, () => true)!;
    input.value = "新文";
    expect(restoreSearchFocus(snapshot)).toBe(false);
    expect(input.focus).not.toHaveBeenCalled();
  });
});
