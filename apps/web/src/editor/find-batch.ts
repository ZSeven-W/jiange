import { Doc, Tx, UndoManager, encodeClientMsg, encodeOps, eqId, idKey, type Op, type OpId, type UndoManagerSnapshot } from "@jiange/collab";
import { FIND_CHANGED_CODEPOINT_LIMIT, FIND_FRAME_LIMIT, FIND_REPLACEMENT_BYTES_LIMIT, FIND_WORK_LIMIT, preflightFindReplace } from "./find-replace-safety";
import { replaceMatches, searchableLocations, type FindMatch } from "./find-replace";
import { readTableFindState, resolveTableFindMatch } from "./table-find";
import { writeTable } from "./table-cells";
import { tableHistoryGuard } from "./table-history-undo";

const STATE_LIMIT = 16 << 20;
type State = NonNullable<ReturnType<typeof readTableFindState>>;
type Cell = { row: number; col: number };
export type TablePlan = { block: OpId; state: State; before: string[][]; after: string[][]; cells: Cell[] };
export type FindBatchAlias = { key: string; block: string; expected: string; versions: (string | null)[] };
type Alias = FindBatchAlias;
type TableHistory = { block: OpId; before: string[][]; after: string[][]; cells: Cell[]; expected: string; versions: (string | null)[]; beforeData: string | null; afterData: string | null; guard: string };
type TextBlock = { block: OpId; parent: OpId };
type Entry = { doc: Doc; text: UndoManager<null>; textBlocks: TextBlock[]; tables: TableHistory[]; beforeAliases: Alias[]; afterAliases: Alias[] };
export type BatchStatus = "replaced" | "unchanged" | "stale" | "size" | "work" | "preflight" | "unavailable";
type BatchResult = { status: BatchStatus; ops: Op[]; count: number };
type StepResult = { status: "ready"; ops: Op[]; rebases: { block: OpId; logical: string | null; actual: string | null; guard: string }[] } | { status: "empty" | "conflict" | "size" };
let serial = 0;

/** Table inverses must not be generated against an offline or unconfirmed replica. */
export function canStepFindBatch(state: { caughtUp: boolean; status: string; unacked: number; blocked: string | null }): boolean {
  return state.caughtUp && state.status === "synced" && state.unacked === 0 && !state.blocked;
}

export function planFindBatch(doc: Doc, matches: readonly FindMatch[], replacement: string): { text: FindMatch[]; tables: TablePlan[] } | null {
  const text: FindMatch[] = [], tables = new Map<string, TablePlan>(), cells = new Map<string, FindMatch[]>();
  for (const match of matches) {
    if (match.doc !== doc) return null;
    if (!match.table) { text.push(match); continue; }
    const key = idKey(match.block);
    let table = tables.get(key);
    if (!table) {
      const state = readTableFindState(doc, match.block);
      if (!state || !state.rows.every((row) => Array.isArray(row) && row.every((value) => typeof value === "string"))) return null;
      table = { block: match.block, state, before: state.rows.map((row) => [...row]), after: state.rows.map((row) => [...row]), cells: [] };
      tables.set(key, table);
    }
    if (!resolveTableFindMatch(doc, match, table.state)) return null;
    const cell = `${key}:${match.table.row}:${match.table.col}`, list = cells.get(cell) ?? [];
    list.push(match); cells.set(cell, list);
  }
  for (const list of cells.values()) {
    const first = list[0], location = first.table!, table = tables.get(idKey(first.block))!;
    const original = table.before[location.row][location.col], chars = [...original];
    let previous = chars.length;
    const parts: string[] = [];
    for (const match of [...list].sort((a, b) => b.start - a.start || b.end - a.end)) {
      if (match.end > previous) return null;
      parts.push(chars.slice(match.end, previous).join(""), replacement);
      previous = match.start;
    }
    parts.push(chars.slice(0, previous).join(""));
    const value = parts.reverse().join("");
    if (value !== original) { table.after[location.row][location.col] = value; table.cells.push({ row: location.row, col: location.col }); }
  }
  return { text, tables: [...tables.values()].filter((table) => table.cells.length > 0) };
}

const withinFrame = (ops: readonly Op[], limit = FIND_FRAME_LIMIT) => !ops.length || encodeClientMsg({ type: "ops", batch: encodeOps([...ops]) }).byteLength <= Math.min(FIND_FRAME_LIMIT, limit);
export function writeFindBatchTables(doc: Doc, tables: readonly { block: OpId; rows: string[][] }[]): Op[] {
  const tx = new Tx(doc);
  for (const table of tables) {
    const state = readTableFindState(doc, table.block);
    if (!state) throw new Error("table changed");
    writeTable(tx, table.block, state.props, table.rows, doc.client);
  }
  return tx.ops;
}

/** An all-or-nothing local operation, with preflight on a separate replica. */
export function applyFindBatch<S>(doc: Doc, undo: UndoManager<S>, history: FindBatchHistory, matches: readonly FindMatch[], replacement: string, frameLimit = FIND_FRAME_LIMIT): BatchResult {
  if (!matches.length || !matches.some((match) => match.table)) return { status: "unavailable", ops: [], count: 0 };
  if (replacement.length * matches.length > FIND_REPLACEMENT_BYTES_LIMIT || new TextEncoder().encode(replacement).length * matches.length > FIND_REPLACEMENT_BYTES_LIMIT) return { status: "size", ops: [], count: 0 };
  if (([...replacement].length * matches.length) + matches.reduce((n, match) => n + [...match.text].length, 0) > FIND_CHANGED_CODEPOINT_LIMIT) return { status: "size", ops: [], count: 0 };
  const original = planFindBatch(doc, matches, replacement);
  if (!original) return { status: "stale", ops: [], count: 0 };
  const work = original.tables.reduce((sum, table) => sum + table.before.reduce((n, row) => n + row.length + row.reduce((total, cell) => total + cell.length, 0), 0), 0);
  if (work > FIND_WORK_LIMIT) return { status: "work", ops: [], count: 0 };
  const textCheck = preflightFindReplace(doc, original.text, replacement, frameLimit);
  if (!textCheck.ok) return { status: textCheck.reason, ops: [], count: 0 };
  try {
    const encoded = doc.encodeState();
    if (encoded.byteLength > STATE_LIMIT) return { status: "work", ops: [], count: 0 };
    const copy = Doc.fromState(doc.client, encoded), rebound = matches.map((match) => ({ ...match, doc: copy })), test = planFindBatch(copy, rebound, replacement);
    if (!test) return { status: "stale", ops: [], count: 0 };
    const textTx = new Tx(copy), textResult = replaceMatches(textTx, test.text, replacement);
    if (textResult.skipped) return { status: "stale", ops: [], count: 0 };
    const tableOps = writeFindBatchTables(copy, test.tables.map((table) => ({ block: table.block, rows: table.after })));
    if (!withinFrame([...textTx.ops, ...tableOps], frameLimit)) return { status: "size", ops: [], count: 0 };
    // Also bound the immediate inverse, which may restore longer cell values.
    const previewHistory = new UndoManager<null>(); previewHistory.record(textTx, null, null);
    const reverseText = previewHistory.undo(copy)?.ops ?? [];
    const reverseTables = writeFindBatchTables(copy, test.tables.map((table) => ({ block: table.block, rows: table.before })));
    if (!withinFrame([...reverseText, ...reverseTables], frameLimit)) return { status: "size", ops: [], count: 0 };
  } catch { return { status: "preflight", ops: [], count: 0 }; }

  // No asynchronous work occurs between validation and applying this batch.
  const plan = planFindBatch(doc, matches, replacement);
  if (!plan) return { status: "stale", ops: [], count: 0 };
  const beforeAliases = history.capture(doc, plan.tables.map((table) => table.block));
  const beforeData = new Map(plan.tables.map((table) => { const version = doc.propVersion(table.block, "tableData"); return [idKey(table.block), version ? idKey(version) : null]; }));
  const textTx = new Tx(doc), textResult = replaceMatches(textTx, plan.text, replacement);
  if (textResult.skipped) throw new Error("find snapshot changed during synchronous application");
  const tableOps = writeFindBatchTables(doc, plan.tables.map((table) => ({ block: table.block, rows: table.after })));
  const ops = [...textTx.ops, ...tableOps];
  if (!ops.length) return { status: "unchanged", ops: [], count: matches.length };
  const textHistory = new UndoManager<null>(); textHistory.shareRemappings(undo); textHistory.record(textTx, null, null);
  const unique = new Map<string, TextBlock>();
  for (const match of plan.text) unique.set(idKey(match.block), { block: match.block, parent: match.parent });
  const tables: TableHistory[] = plan.tables.map((table) => {
    const state = readTableFindState(doc, table.block)!;
    const version = doc.propVersion(table.block, "tableData");
    return { block: table.block, before: table.before, after: table.after, cells: table.cells, expected: state.snapshot, versions: table.cells.map((cell) => state.cellVersion(cell.row, cell.col)), beforeData: beforeData.get(idKey(table.block)) ?? null, afterData: version ? idKey(version) : null, guard: tableHistoryGuard(doc, table.block) };
  });
  history.record(undo, { doc, text: textHistory, textBlocks: [...unique.values()], tables, beforeAliases, afterAliases: [] });
  return { status: "replaced", ops, count: matches.length };
}

export class FindBatchHistory {
  private readonly entries = new Map<string, Entry>();
  private readonly tableActions = new Map<string, { undo: { before: Alias[]; after: Alias[] }[]; redo: { before: Alias[]; after: Alias[] }[] }>();
  capture(doc: Doc, blocks: readonly OpId[], exclude?: string): Alias[] {
    const keys = new Set(blocks.map(idKey)), states = new Map<string, ReturnType<typeof readTableFindState>>(), result: Alias[] = [];
    for (const [key, entry] of this.entries) {
      if (key === exclude || entry.doc !== doc) continue;
      for (const table of entry.tables) {
        const block = idKey(table.block); if (!keys.has(block)) continue;
        if (!states.has(block)) states.set(block, readTableFindState(doc, table.block));
        const state = states.get(block);
        if (state && state.snapshot === table.expected && table.cells.every((cell, i) => state.cellVersion(cell.row, cell.col) === table.versions[i])) result.push({ key, block, expected: table.expected, versions: [...table.versions] });
      }
    }
    return result;
  }
  private rebase(doc: Doc, aliases: readonly Alias[]) {
    for (const alias of aliases) {
      const table = this.entries.get(alias.key)?.tables.find((item) => idKey(item.block) === alias.block);
      if (!table || table.expected !== alias.expected || table.versions.some((value, i) => value !== alias.versions[i])) continue;
      const state = readTableFindState(doc, table.block); if (!state) continue;
      table.expected = state.snapshot; table.versions = table.cells.map((cell) => state.cellVersion(cell.row, cell.col));
    }
  }
  rebaseCaptured(doc: Doc, aliases: readonly FindBatchAlias[], allowed: ReadonlySet<string>) { this.rebase(doc, aliases.filter((alias) => allowed.has(alias.block))); }
  tableBlocks(key: string): OpId[] { return this.entries.get(key)?.tables.map((table) => table.block) ?? []; }
  /** Track guarded cell actions interleaved with a mixed replacement. */
  recordTableChange(key: string, before: Alias[], merged: boolean) {
    if (!before.length && !this.tableActions.has(key)) return;
    const history = this.tableActions.get(key) ?? { undo: [], redo: [] };
    if (!merged || !history.undo.length) history.undo.push({ before, after: [] });
    history.redo = [];
    if (history.undo.length > 500) history.undo.shift();
    this.tableActions.delete(key); this.tableActions.set(key, history);
    if (this.tableActions.size > 500) this.tableActions.delete(this.tableActions.keys().next().value!);
  }
  finishTableChange(doc: Doc, key: string, redo: boolean, current: Alias[]) {
    let history = this.tableActions.get(key);
    // The table action may predate the mixed find-batch replacement. Capture
    // currently matching batch history as its inverse crosses that older
    // action, so redoing it can rebase the newer find-batch marker safely.
    if (!history && current.length) {
      history = { undo: [], redo: [] };
      this.tableActions.set(key, history);
      if (this.tableActions.size > 500) this.tableActions.delete(this.tableActions.keys().next().value!);
    }
    if (!history) return;
    const from = redo ? history.redo : history.undo, to = redo ? history.undo : history.redo;
    const item = from.pop();
    if (!item) {
      if (current.length) {
        to.push(redo ? { before: current, after: [] } : { before: [], after: current });
        if (to.length > 500) to.shift();
      }
      return;
    }
    this.rebase(doc, redo ? item.after : item.before);
    if (redo) item.before = current; else item.after = current;
    to.push(item);
  }
  discardTableChange(key: string, redo: boolean) {
    const history = this.tableActions.get(key); if (!history) return;
    (redo ? history.redo : history.undo).pop();
    if (!history.undo.length && !history.redo.length) this.tableActions.delete(key);
  }
  record<S>(undo: UndoManager<S>, entry: Entry) {
    for (const key of this.entries.keys()) if (!undo.hasMarker(key)) this.entries.delete(key);
    const key = `find-batch:${++serial}`;
    undo.seal(); undo.recordMarker(key); undo.seal();
    this.entries.set(key, entry);
  }
  discard(key: string) { this.entries.delete(key); }
  step<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean): StepResult {
    const entry = this.entries.get(key);
    if (!entry || undo.peekMarker(redo) !== key) return { status: "empty" };
    if (entry.doc !== doc) return { status: "conflict" };
    const locations = new Map(searchableLocations(doc, { includeMath: true }).map((item) => [idKey(item.block), item.parent]));
    if (entry.textBlocks.some((item) => !locations.has(idKey(undo.map(item.block))) || !eqId(locations.get(idKey(undo.map(item.block)))!, undo.map(item.parent)))) return { status: "conflict" };
    for (const table of entry.tables) {
      const state = readTableFindState(doc, table.block);
      if (!state || state.snapshot !== table.expected || table.cells.some((cell, i) => state.cellVersion(cell.row, cell.col) !== table.versions[i])) return { status: "conflict" };
    }
    try {
      const state = doc.encodeState(); if (state.byteLength > STATE_LIMIT) return { status: "size" };
      const copy = Doc.fromState(doc.client, state), text = entry.text.preview(copy, redo)?.ops ?? [];
      const tables = writeFindBatchTables(copy, entry.tables.map((table) => ({ block: table.block, rows: redo ? table.after : table.before })));
      if (!withinFrame([...text, ...tables])) return { status: "size" };
    } catch { return { status: "conflict" }; }
    const aliases = this.capture(doc, entry.tables.map((table) => table.block), key);
    const text = (redo ? entry.text.redo(doc) : entry.text.undo(doc))?.ops ?? [];
    const tables = writeFindBatchTables(doc, entry.tables.map((table) => ({ block: table.block, rows: redo ? table.after : table.before })));
    for (const table of entry.tables) {
      const state = readTableFindState(doc, table.block)!;
      table.expected = state.snapshot; table.versions = table.cells.map((cell) => state.cellVersion(cell.row, cell.col));
    }
    this.rebase(doc, redo ? entry.afterAliases : entry.beforeAliases);
    if (redo) entry.beforeAliases = aliases; else entry.afterAliases = aliases;
    undo.moveMarker(redo, key);
    return { status: "ready", ops: [...text, ...tables], rebases: entry.tables.map((table) => { const version = doc.propVersion(table.block, "tableData"); return { block: table.block, logical: redo ? table.afterData : table.beforeData, actual: version ? idKey(version) : null, guard: table.guard }; }) };
  }

  exportState<S>(doc: Doc, undo: UndoManager<S>): {
    v: 1;
    entries: [string, { text: UndoManagerSnapshot; textBlocks: TextBlock[]; tables: TableHistory[]; beforeAliases: Alias[]; afterAliases: Alias[] }][];
    tableActions: [string, { undo: { before: Alias[]; after: Alias[] }[]; redo: { before: Alias[]; after: Alias[] }[] }][];
  } {
    const entries: [string, { text: UndoManagerSnapshot; textBlocks: TextBlock[]; tables: TableHistory[]; beforeAliases: Alias[]; afterAliases: Alias[] }][] = [];
    for (const [key, entry] of this.entries) {
      if (entry.doc !== doc || !undo.hasMarker(key)) continue;
      entries.push([
        key,
        {
          text: entry.text.exportState(),
          textBlocks: JSON.parse(JSON.stringify(entry.textBlocks)) as TextBlock[],
          tables: JSON.parse(JSON.stringify(entry.tables)) as TableHistory[],
          beforeAliases: JSON.parse(JSON.stringify(entry.beforeAliases)) as Alias[],
          afterAliases: JSON.parse(JSON.stringify(entry.afterAliases)) as Alias[],
        },
      ]);
    }
    const tableActions: [string, { undo: { before: Alias[]; after: Alias[] }[]; redo: { before: Alias[]; after: Alias[] }[] }][] = [];
    for (const [key, act] of this.tableActions) {
      if (!undo.hasMarker(key)) continue;
      tableActions.push([key, JSON.parse(JSON.stringify(act)) as { undo: { before: Alias[]; after: Alias[] }[]; redo: { before: Alias[]; after: Alias[] }[] }]);
    }
    return { v: 1, entries, tableActions };
  }

  importState<S>(doc: Doc, undo: UndoManager<S>, raw: unknown): Set<string> {
    const restoredKeys = new Set<string>();
    if (typeof raw !== "object" || raw === null) return restoredKeys;
    const data = raw as { v?: unknown; entries?: unknown; tableActions?: unknown };
    if (data.v !== 1 || !Array.isArray(data.entries) || !Array.isArray(data.tableActions)) return restoredKeys;
    const isOp = (v: unknown): v is OpId => typeof v === "object" && v !== null && Number.isSafeInteger((v as OpId).client) && (v as OpId).client >= 0 && Number.isSafeInteger((v as OpId).clock) && (v as OpId).clock >= 0;
    const isAlias = (a: unknown): a is Alias => typeof a === "object" && a !== null && typeof (a as Alias).key === "string" && typeof (a as Alias).block === "string" && typeof (a as Alias).expected === "string" && Array.isArray((a as Alias).versions);
    const isTableHist = (t: unknown): t is TableHistory =>
      typeof t === "object" &&
      t !== null &&
      isOp((t as TableHistory).block) &&
      Array.isArray((t as TableHistory).before) &&
      Array.isArray((t as TableHistory).after) &&
      Array.isArray((t as TableHistory).cells) &&
      typeof (t as TableHistory).expected === "string" &&
      Array.isArray((t as TableHistory).versions) &&
      typeof (t as TableHistory).guard === "string";
    const parsedEntries: [string, Entry][] = [];
    for (const pair of data.entries) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") return restoredKeys;
      const item = pair[1] as { text?: unknown; textBlocks?: unknown; tables?: unknown; beforeAliases?: unknown; afterAliases?: unknown };
      if (!item || !Array.isArray(item.textBlocks) || !Array.isArray(item.tables) || !Array.isArray(item.beforeAliases) || !Array.isArray(item.afterAliases)) return restoredKeys;
      if (!item.textBlocks.every((tb: unknown) => typeof tb === "object" && tb !== null && isOp((tb as TextBlock).block) && isOp((tb as TextBlock).parent))) return restoredKeys;
      if (!item.tables.every(isTableHist) || !item.beforeAliases.every(isAlias) || !item.afterAliases.every(isAlias)) return restoredKeys;
      const text = new UndoManager<null>();
      text.shareRemappings(undo);
      if (!text.importState(item.text)) return restoredKeys;
      parsedEntries.push([
        pair[0],
        {
          doc,
          text,
          textBlocks: JSON.parse(JSON.stringify(item.textBlocks)) as TextBlock[],
          tables: JSON.parse(JSON.stringify(item.tables)) as TableHistory[],
          beforeAliases: JSON.parse(JSON.stringify(item.beforeAliases)) as Alias[],
          afterAliases: JSON.parse(JSON.stringify(item.afterAliases)) as Alias[],
        },
      ]);
    }
    const parsedActions: [string, { undo: { before: Alias[]; after: Alias[] }[]; redo: { before: Alias[]; after: Alias[] }[] }][] = [];
    for (const pair of data.tableActions) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") return restoredKeys;
      const act = pair[1] as { undo?: unknown; redo?: unknown };
      const okList = (list: unknown): list is { before: Alias[]; after: Alias[] }[] =>
        Array.isArray(list) && list.every((i) => typeof i === "object" && i !== null && Array.isArray((i as { before: Alias[] }).before) && Array.isArray((i as { after: Alias[] }).after) && (i as { before: Alias[] }).before.every(isAlias) && (i as { after: Alias[] }).after.every(isAlias));
      if (!act || !okList(act.undo) || !okList(act.redo)) return restoredKeys;
      parsedActions.push([pair[0], JSON.parse(JSON.stringify(act)) as { undo: { before: Alias[]; after: Alias[] }[]; redo: { before: Alias[]; after: Alias[] }[] }]);
    }
    this.entries.clear();
    this.tableActions.clear();
    for (const [key, entry] of parsedEntries) {
      this.entries.set(key, entry);
      restoredKeys.add(key);
      const seq = Number(key.split(":").at(-1));
      if (Number.isSafeInteger(seq) && seq > serial) serial = seq;
    }
    for (const [key, act] of parsedActions) this.tableActions.set(key, act);
    return restoredKeys;
  }
}
