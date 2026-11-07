/**
 * Native form controls embedded inside the editor own their keyboard, input,
 * composition and selection handling. In particular, a table cell must not
 * be treated as the last contenteditable selection in the document.
 */
export function isNativeControl(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  return (target as Element).closest("input, textarea, select, button") !== null;
}

/** Copy protection applies to both the document and its native controls. */
export function editorClipboardRoute(target: EventTarget | null, protectedContent: boolean): "block" | "native" | "editor" {
  if (protectedContent) return "block";
  return isNativeControl(target) ? "native" : "editor";
}
