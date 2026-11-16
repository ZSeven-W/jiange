/** Visual candidates are computed from the current document viewport. */
export interface TableWidthSnapCandidate {
  kind: "equal" | "table" | "page";
  width: number;
  x: number;
  top: number;
  bottom: number;
}

/** Pick the closest visible target; ties prefer equal widths, then tables. */
export function snapTableWidth(raw: number, candidates: readonly TableWidthSnapCandidate[], disabled = false, threshold = 6): { width: number; guide: TableWidthSnapCandidate | null } {
  const width = Number.isFinite(raw) ? Math.max(100, Math.min(100000, Math.round(raw))) : 100;
  if (disabled || !Number.isFinite(raw) || !Number.isFinite(threshold) || threshold < 0) return { width, guide: null };
  const rank = { equal: 0, table: 1, page: 2 };
  const suitable = candidates.filter(candidate => [candidate.width, candidate.x, candidate.top, candidate.bottom].every(Number.isFinite) && candidate.width >= 100 && candidate.width <= 100000 && candidate.bottom > candidate.top && Math.abs(candidate.width - width) <= threshold);
  suitable.sort((a, b) => Math.abs(a.width - width) - Math.abs(b.width - width) || rank[a.kind] - rank[b.kind]);
  return suitable[0] ? { width: suitable[0].width, guide: suitable[0] } : { width, guide: null };
}
