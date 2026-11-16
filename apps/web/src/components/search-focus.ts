export type SearchFocusGuard = () => boolean;
export type SearchGuardCapture = () => SearchFocusGuard;
type Guard = SearchFocusGuard | null;
type TextSelection = { kind: "input"; value: string; start: number; end: number; direction: "forward" | "backward" | "none" };
type DomSelection = { kind: "dom"; anchor: Node; anchorOffset: number; focus: Node; focusOffset: number; start: Node; startOffset: number; end: Node; endOffset: number; anchorText: string | null; focusText: string | null; selected: string };
type CapturedSelection = TextSelection | DomSelection | { kind: "none" } | { kind: "invalid" };
export type SearchFocus = { opener: HTMLElement; selection: CapturedSelection; guard: Guard; documentEditor: boolean };

/** Capture the actual selection before the search input takes focus. */
export function captureSearchFocus(opener: HTMLElement | null, guard: Guard): SearchFocus | null {
  if (!opener) return null;
  const input = opener.tagName === "TEXTAREA" || opener.tagName === "INPUT" ? opener as HTMLInputElement | HTMLTextAreaElement : null;
  const editable = opener.isContentEditable || !!input && !input.readOnly && !input.disabled;
  const documentEditor = editable && !!opener.closest("[data-document-focus-scope]");
  let selection: CapturedSelection = { kind: "none" };
  try {
    if (input && input.selectionStart !== null && input.selectionEnd !== null) {
      selection = { kind: "input", value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection ?? "none" };
    } else if (input && documentEditor) {
      selection = { kind: "invalid" };
    } else if (opener.isContentEditable) {
      const selected = opener.ownerDocument.getSelection();
      if (!selected || selected.rangeCount !== 1 || !selected.anchorNode || !selected.focusNode || !opener.contains(selected.anchorNode) || !opener.contains(selected.focusNode)) selection = { kind: "invalid" };
      else {
        const range = selected.getRangeAt(0);
        selection = { kind: "dom", anchor: selected.anchorNode, anchorOffset: selected.anchorOffset, focus: selected.focusNode, focusOffset: selected.focusOffset, start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset, anchorText: selected.anchorNode.textContent, focusText: selected.focusNode.textContent, selected: range.toString() };
      }
    }
  } catch { selection = { kind: "invalid" }; }
  return { opener, selection, guard, documentEditor };
}

/** Return false rather than directing typing into a stale or changed selection. */
export function restoreSearchFocus(snapshot: SearchFocus): boolean {
  const { opener, selection, guard, documentEditor } = snapshot;
  if (!opener.isConnected || !opener.getClientRects().length || selection.kind === "invalid") return false;
  try {
    if (documentEditor && (!guard || !guard())) return false;
    if (selection.kind === "input") {
      const input = opener as HTMLInputElement | HTMLTextAreaElement;
      if (input.disabled || input.value !== selection.value || documentEditor && input.readOnly) return false;
      input.setSelectionRange(selection.start, selection.end, selection.direction);
      input.focus({ preventScroll: true });
    } else if (selection.kind === "dom") {
      if (!opener.isContentEditable || !opener.contains(selection.anchor) || !opener.contains(selection.focus) || !opener.contains(selection.start) || !opener.contains(selection.end) || selection.anchor.textContent !== selection.anchorText || selection.focus.textContent !== selection.focusText) return false;
      const range = opener.ownerDocument.createRange();
      range.setStart(selection.start, selection.startOffset); range.setEnd(selection.end, selection.endOffset);
      if (range.toString() !== selection.selected) return false;
      opener.focus({ preventScroll: true });
      const current = opener.ownerDocument.getSelection();
      if (!current) return false;
      current.setBaseAndExtent(selection.anchor, selection.anchorOffset, selection.focus, selection.focusOffset);
      // The editor keeps its own model selection. Synchronize it before a
      // focus-triggered render can restore a stale model position.
      opener.ownerDocument.dispatchEvent(new Event("selectionchange"));
    } else opener.focus({ preventScroll: true });
    return opener.ownerDocument.activeElement === opener;
  } catch {
    if (documentEditor && opener.ownerDocument.activeElement === opener) opener.blur();
    return false;
  }
}
