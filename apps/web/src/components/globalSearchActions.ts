/** Invalidates a pending access check when the user changes search intent. */
export class SearchOpenGuard {
  private version = 0;
  private pending = false;
  private active = true;

  activate() { this.active = true; }
  begin(): number | null {
    if (!this.active || this.pending) return null;
    this.pending = true;
    return ++this.version;
  }
  current(version: number): boolean { return this.active && this.version === version; }
  finish(version: number) { if (this.current(version)) this.pending = false; }
  invalidate() { this.version++; this.pending = false; }
  dispose() { this.active = false; this.invalidate(); }
}

/** Select only an item in the currently visible, verified result set. */
export function searchKeyboardTarget(ids: number[], selected: number | null, key: "ArrowDown" | "ArrowUp" | "Enter"): number | null {
  if (!ids.length) return null;
  const index = selected === null ? -1 : ids.indexOf(selected);
  if (key === "Enter") return ids[index < 0 ? 0 : index];
  if (key === "ArrowDown") return ids[index < 0 ? 0 : (index + 1) % ids.length];
  return ids[index < 0 ? ids.length - 1 : (index - 1 + ids.length) % ids.length];
}
