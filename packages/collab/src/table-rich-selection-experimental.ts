import { eqId, idKey, type OpId } from "./id.js";
import { ExperimentalTable, validTableMarkValue, type TableMarkKey, type TableMarkState, type TableOp } from "./table-experimental.js";
import { type Op } from "./ops.js";

/** Internal prototype: the host owns ID allocation, authorization and transport. */
const MAX_SELECTED = 4096;
const MAX_SNAPSHOT_BYTES = 8 << 20;
const KEYS: readonly TableMarkKey[] = ["bold", "color", "italic", "strike", "underline"];
type Character = { id: OpId; text: string; marks: Record<TableMarkKey, TableMarkState> };
type SelectionData = { table: ExperimentalTable; row: OpId; column: OpId; chars: Character[] };
export interface TableTextSelection { readonly length: number }
export interface TableMarkPlan { readonly ops: readonly Extract<TableOp, { kind: "text-mark" }>[] }
type PlanEntry = { target: OpId; before: TableMarkState; after: TableMarkState };
type PlanData = { table: ExperimentalTable; row: OpId; column: OpId; key: TableMarkKey; base: string; entries: PlanEntry[] };
export type TableMarkPlanResult = { status: "ready"; plan: TableMarkPlan } | { status: "invalid" | "stale" | "conflict" | "unchanged" | "limit" };
const selections = new WeakMap<TableTextSelection, SelectionData>();
const plans = new WeakMap<TableMarkPlan, PlanData>();
const copyId = (id: OpId): OpId => ({ client: id.client, clock: id.clock });
const validId = (id: OpId) => !!id && Number.isSafeInteger(id.client) && id.client > 0 && Number.isSafeInteger(id.clock) && id.clock > 0;
const sameVersion = (a: OpId | null, b: OpId | null) => a === null ? b === null : b !== null && eqId(a, b);
const sameState = (a: TableMarkState, b: TableMarkState) => a.value === b.value && sameVersion(a.version, b.version);
const copyState = (state: TableMarkState): TableMarkState => ({ value: state.value, version: state.version ? copyId(state.version) : null });

/** Capture code-point offsets as immutable character identities. */
export function captureTableTextSelection(table: ExperimentalTable, row: OpId, column: OpId, start: number, end: number): TableTextSelection | null {
  if (table.pendingCount || table.rejected.length || !validId(row) || !validId(column) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > MAX_SELECTED) return null;
  const rich = table.cellRich(row, column);
  if (!rich || end > rich.length) return null;
  const chars: Character[] = [];
  for (const char of rich.slice(start, end)) {
    const marks = {} as Record<TableMarkKey, TableMarkState>;
    for (const key of KEYS) marks[key] = copyState(table.cellMark(row, column, char.id, key)!);
    chars.push({ id: copyId(char.id), text: char.text, marks });
  }
  const selection: TableTextSelection = Object.freeze({ length: chars.length });
  selections.set(selection, { table, row: copyId(row), column: copyId(column), chars });
  return selection;
}

/** Convert native UTF-16 offsets only when the displayed text is still exact. */
export function captureTableUTF16Selection(table: ExperimentalTable, row: OpId, column: OpId, displayed: string, start: number, end: number): TableTextSelection | null {
  if (typeof displayed !== "string" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > displayed.length || table.cellText(row, column) !== displayed) return null;
  let utf16 = 0, codepoints = 0, first: number | null = start === 0 ? 0 : null, last: number | null = null;
  for (const char of displayed) {
    utf16 += char.length; codepoints++;
    if (utf16 === start) first = codepoints;
    if (utf16 === end) { last = codepoints; break; }
    if (utf16 > end) break;
  }
  return first === null || last === null ? null : captureTableTextSelection(table, row, column, first, last);
}

function validIDs(ids: readonly OpId[], count: number, afterClock: number): boolean {
  if (!Array.isArray(ids) || ids.length !== count || count < 1 || !validId(ids[0])) return false;
  const unique = new Set<string>(), client = ids[0].client;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]; if (!validId(id) || id.clock <= afterClock || i > 0 && id.clock <= ids[i - 1].clock || id.client !== client || unique.has(idKey(id))) return false;
    unique.add(idKey(id));
  }
  return true;
}

function makePlan(table: ExperimentalTable, row: OpId, column: OpId, key: TableMarkKey, changes: readonly { target: OpId; before: TableMarkState; value: string | null; id: OpId }[]): TableMarkPlanResult {
  if (!changes.length) return { status: "unchanged" };
  try {
    const base = table.snapshot();
    if (base.length > MAX_SNAPSHOT_BYTES || new TextEncoder().encode(base).byteLength > MAX_SNAPSHOT_BYTES) return { status: "limit" };
    const clone = table.fork(), ops: Extract<TableOp, { kind: "text-mark" }>[] = [], entries: PlanEntry[] = [];
    for (const change of changes) {
      const op: Extract<TableOp, { kind: "text-mark" }> = { kind: "text-mark", id: copyId(change.id), row: copyId(row), column: copyId(column), target: copyId(change.target), key, value: change.value };
      clone.apply(op);
      const after = clone.cellMark(row, column, change.target, key)!;
      entries.push({ target: copyId(change.target), before: copyState(change.before), after: copyState(after) });
      Object.freeze(op.id); Object.freeze(op.row); Object.freeze(op.column); Object.freeze(op.target); ops.push(Object.freeze(op));
    }
    const plan: TableMarkPlan = Object.freeze({ ops: Object.freeze(ops) });
    plans.set(plan, { table, row: copyId(row), column: copyId(column), key, base, entries });
    return { status: "ready", plan };
  } catch { return { status: "limit" }; }
}

/** Prepare explicit formatting on only the originally selected characters. */
export function prepareTableTextMark(table: ExperimentalTable, selection: TableTextSelection, key: TableMarkKey, value: string | null, ids: readonly OpId[]): TableMarkPlanResult {
  const captured = selections.get(selection);
  if (!captured || captured.table !== table || !validTableMarkValue(key, value) || !validIDs(ids, captured.chars.length, table.maxClock)) return { status: "invalid" };
  if (table.pendingCount || table.rejected.length) return { status: "stale" };
  const rich = table.cellRich(captured.row, captured.column);
  if (!rich) return { status: "stale" };
  const order = new Map(rich.map((char, index) => [idKey(char.id), { index, text: char.text }]));
  const changes: { target: OpId; before: TableMarkState; value: string | null; id: OpId }[] = [];
  let previous = -1;
  for (const [index, original] of captured.chars.entries()) {
    const current = order.get(idKey(original.id)), state = table.cellMark(captured.row, captured.column, original.id, key);
    if (!current || current.index <= previous || current.text !== original.text || !state || !sameState(state, original.marks[key])) return { status: "stale" };
    previous = current.index;
    if (state.value !== value) changes.push({ target: original.id, before: state, value, id: ids[index] });
  }
  return makePlan(table, captured.row, captured.column, key, changes);
}

/** Build the inverse of a confirmed plan without overwriting newer marks. */
export function prepareTableTextMarkInverse(table: ExperimentalTable, previous: TableMarkPlan, ids: readonly OpId[]): TableMarkPlanResult {
  const data = plans.get(previous);
  if (!data || data.table !== table || !validIDs(ids, data.entries.length, table.maxClock)) return { status: "invalid" };
  if (table.pendingCount || table.rejected.length) return { status: "stale" };
  const changes: { target: OpId; before: TableMarkState; value: string | null; id: OpId }[] = [];
  for (const [index, entry] of data.entries.entries()) {
    const current = table.cellMark(data.row, data.column, entry.target, data.key);
    if (!current || !sameState(current, entry.after)) return { status: "conflict" };
    changes.push({ target: entry.target, before: current, value: entry.before.value, id: ids[index] });
  }
  return makePlan(table, data.row, data.column, data.key, changes);
}

/** The host must still commit against an authoritative document version. */
export function tableMarkPlanIsCurrent(table: ExperimentalTable, plan: TableMarkPlan): boolean {
  const data = plans.get(plan);
  if (!data || data.table !== table) return false;
  return table.snapshot() === data.base;
}

/** Wrap a current plan in document table frames without exposing mutable plan state. */
export function tableMarkPlanFrames(table: ExperimentalTable, plan: TableMarkPlan, block: OpId): Extract<Op, { t: "ttable" }>[] | null {
  if (!block || !Number.isSafeInteger(block.client) || block.client < 0 || !Number.isSafeInteger(block.clock) || block.clock <= 0 || !tableMarkPlanIsCurrent(table, plan)) return null;
  const encoder = new TextEncoder(), frames: Extract<Op, { t: "ttable" }>[] = [];
  for (const op of plan.ops) {
    if (eqId(op.id, block)) return null;
    const payload = encoder.encode(JSON.stringify(op));
    frames.push({ t: "ttable", id: copyId(op.id), block: copyId(block), payload });
  }
  return frames;
}
