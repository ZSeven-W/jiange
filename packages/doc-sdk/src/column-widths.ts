import { eqId, idKey, ROOT, type Doc, type OpId, type Tx } from "@zseven-w/collab";

export const COLUMN_WIDTHS = "columnWidths";
const DEFAULT_WEIGHT = 1000;
const MAX_ENTRIES = 1000;
const MAX_TOTAL = 1_000_000_000;
const MAX_RAW_LENGTH = 32_000;
const validId = (id: string) => /^\d+:\d+$/.test(id) && id.split(":").every((n) => Number.isSafeInteger(Number(n)));

function parse(raw: string | undefined): Record<string, number> | null {
  if (raw === undefined || raw === "") return Object.create(null);
  if (raw.length > MAX_RAW_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.length > MAX_ENTRIES || entries.some(([key, weight]) => !validId(key) || typeof weight !== "number" || !Number.isSafeInteger(weight) || weight < 1 || weight > MAX_TOTAL)) return null;
    if (entries.reduce((sum, [, weight]) => sum + (weight as number), 0) > MAX_TOTAL) return null;
    return Object.assign(Object.create(null), value);
  } catch { return null; }
}

/** The conditional API accepts only bounded width metadata, never document text. */
export const validColumnWidths = (raw: string): boolean => parse(raw) !== null;

/** Invalid or unknown metadata is rendered as equal widths, never trusted as CSS. */
export function columnWeights(raw: string | undefined, ids: readonly string[]): number[] {
  const values = parse(raw);
  const weights = ids.map((id) => values?.[id] ?? DEFAULT_WEIGHT);
  return weights.reduce((sum, weight) => sum + weight, 0) <= MAX_TOTAL ? weights : ids.map(() => DEFAULT_WEIGHT);
}

export interface ColumnWidthSnapshot {
  readonly doc: Doc;
  readonly parent: Readonly<OpId>;
  readonly left: string;
  readonly right: string;
  readonly ids: readonly string[];
  readonly raw: string | undefined;
  readonly version: string | null;
  readonly weights: readonly number[];
}

/** Capture a stable pair, structure, and property version before dragging. */
export function captureColumnWidths(doc: Doc, parent: OpId, left: string, right: string): ColumnWidthSnapshot | null {
  if (!doc.hasBlock(parent) || !validId(left) || !validId(right)) return null;
  const info = doc.blockInfo(parent);
  if (info.type !== "columns" || !eqId(info.parent, ROOT)) return null;
  const ids = doc.children(parent).map(idKey), index = ids.indexOf(left);
  if (ids.length < 2 || ids.length > MAX_ENTRIES || index < 0 || ids[index + 1] !== right) return null;
  const raw = info.props[COLUMN_WIDTHS], values = parse(raw);
  if (!values) return null;
  const weights = ids.map((id) => values[id] ?? DEFAULT_WEIGHT);
  if (weights.reduce((sum, weight) => sum + weight, 0) > MAX_TOTAL) return null;
  const id = doc.propVersion(parent, COLUMN_WIDTHS);
  return Object.freeze({ doc, parent: Object.freeze({ ...parent }), left, right, ids: Object.freeze(ids), raw, version: id ? idKey(id) : null, weights: Object.freeze(weights) });
}

/** Commit only if the captured structure and width register are unchanged. */
export function applyColumnWidths(tx: Tx, snapshot: ColumnWidthSnapshot, fraction: number): "applied" | "unchanged" | "changed" | "invalid" {
  const doc = tx.doc;
  if (doc !== snapshot.doc || !Number.isFinite(fraction) || fraction < 0.1 || fraction > 0.9) return "invalid";
  const current = captureColumnWidths(doc, snapshot.parent, snapshot.left, snapshot.right);
  if (!current || current.raw !== snapshot.raw || current.version !== snapshot.version || current.ids.length !== snapshot.ids.length || current.ids.some((id, index) => id !== snapshot.ids[index])) return "changed";
  const index = current.ids.indexOf(current.left), total = current.weights[index] + current.weights[index + 1];
  const leftWeight = Math.max(1, Math.min(total - 1, Math.round(total * fraction))), rightWeight = total - leftWeight;
  if (leftWeight === current.weights[index] && rightWeight === current.weights[index + 1]) return "unchanged";
  const values = parse(current.raw)!;
  values[current.left] = leftWeight; values[current.right] = rightWeight;
  const raw = JSON.stringify(values);
  if (raw.length > MAX_RAW_LENGTH || !validColumnWidths(raw)) return "invalid";
  tx.setProp(snapshot.parent, COLUMN_WIDTHS, raw);
  return tx.ops.length ? "applied" : "unchanged";
}
