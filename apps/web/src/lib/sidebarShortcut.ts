/** Feishu's document navigation shortcut; leave IME and modified chords alone. */
export function isDocumentSidebarShortcut(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "repeat" | "defaultPrevented">): boolean {
  return !event.defaultPrevented && !event.isComposing && !event.repeat && !event.altKey && !event.shiftKey && (event.metaKey !== event.ctrlKey) && (event.code === "BracketRight" || event.key === "]");
}
