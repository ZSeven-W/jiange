import { Doc, Tx, encodeClientMsg, encodeOps, eqId, idKey, ROOT, type OpId } from "@zseven-w/collab";
import { findMatches, type FindMatch, type FindOptions } from "./find-replace";
import { cellKey, isCellTable, tableRowsOf, writeTable, TBL_ROWS, TBL_COLS, TBL_BASE, TBL_MIRROR, TBL_VERSION } from "./table-cells";
import { coverMap, parseMerges } from "./table-ops";

const STATE_LIMIT = 16 << 20;
const FRAME_LIMIT = 8 << 20;
const REPLACEMENT_LIMIT = 1 << 20;
type TableState = { rows: string[][]; hidden: Map<string, unknown>; snapshot: string; props: Record<string, string>; cellVersion: (row: number, col: number) => string | null };
const version = (doc: Doc, block: OpId, key: string) => { const id = doc.propVersion(block, key); return id ? idKey(id) : null; };
const axis = (raw: string | undefined): string[] => { try { const result: unknown = JSON.parse(raw ?? "[]"); return Array.isArray(result) && result.every((v) => typeof v === "string") ? result : []; } catch { return []; } };

/** Capture the whole visible grid and structural versions so stale coordinates cannot target another cell. */
export function readTableFindState(doc: Doc, block: OpId): TableState | null {
  if (!doc.hasBlock(block)) return null;
  const info = doc.blockInfo(block);
  if (info.type !== "table" || !eqId(info.parent, ROOT)) return null;
  const props = info.props, rows = tableRowsOf(props);
  const hidden = coverMap(parseMerges(props.tableMerges, rows.length, rows[0]?.length ?? 0));
  const keys = ["type", "tableData", "tableMerges", TBL_VERSION, TBL_ROWS, TBL_COLS, TBL_BASE, TBL_MIRROR];
  const snapshot = JSON.stringify([rows, props.tableMerges ?? "", props[TBL_ROWS] ?? "", props[TBL_COLS] ?? "", keys.map((key) => version(doc, block, key))]);
  const rowIds = isCellTable(props) ? axis(props[TBL_ROWS]) : [], colIds = isCellTable(props) ? axis(props[TBL_COLS]) : [];
  return { rows, hidden, snapshot, props, cellVersion: (row, col) => rowIds[row] && colIds[col] ? version(doc, block, cellKey(rowIds[row], colIds[col])) : null };
}

/** Find visible table cells as well as ordinary body text (and optional formulas), in document order. */
export function findDocumentMatches(doc: Doc, query: string, options: FindOptions = {}): FindMatch[] {
  const text = findMatches(doc, query, options);
  if (!query) return text;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options.caseSensitive ? "gu" : "giu");
  const blocks = doc.view().blocks, order = new Map(blocks.map((item, index) => [item.id, index]));
  const tables: FindMatch[] = [];
  for (const item of blocks) {
    if (item.type !== "table" || item.parent !== idKey(ROOT)) continue;
    const [client, clock] = item.id.split(":").map(Number), block = { client, clock }, state = readTableFindState(doc, block);
    if (!state) continue;
    state.rows.forEach((row, ri) => { if (!Array.isArray(row)) return; row.forEach((cell, ci) => {
      if (typeof cell !== "string") return;
      if (state.hidden.get(`${ri}:${ci}`) === "hidden") return;
      pattern.lastIndex = 0;
      for (const found of cell.matchAll(pattern)) {
        const start = [...cell.slice(0, found.index)].length, end = start + [...found[0]].length;
        tables.push({ doc, block, parent: ROOT, start, end, ids: [], text: found[0], table: { row: ri, col: ci, snapshot: state.snapshot, cellVersion: state.cellVersion(ri, ci) } });
      }
    }); });
  }
  return [...text, ...tables].sort((a, b) => (order.get(idKey(a.block)) ?? Infinity) - (order.get(idKey(b.block)) ?? Infinity));
}

export function resolveTableFindMatch(doc: Doc, match: FindMatch, state = readTableFindState(doc, match.block)): { state: TableState; before: string } | null {
  const t = match.table;
  if (!t || match.doc !== doc || !eqId(match.parent, ROOT) || ![t.row, t.col, match.start, match.end].every(Number.isSafeInteger) || t.row < 0 || t.col < 0 || match.start < 0 || match.end <= match.start || !state || state.snapshot !== t.snapshot || state.cellVersion(t.row, t.col) !== t.cellVersion || state.hidden.get(`${t.row}:${t.col}`) === "hidden") return null;
  const before = state.rows[t.row]?.[t.col];
  if (typeof before !== "string") return null;
  const chars = [...before];
  if (match.end > chars.length || chars.slice(match.start, match.end).join("") !== match.text) return null;
  return { state, before };
}

/** Validate and build a single-cell replacement without changing the live document. */
export function planTableFindReplace(doc: Doc, match: FindMatch, replacement: string): { state: TableState; before: string; after: string; rows: string[][] } | null {
  const found = resolveTableFindMatch(doc, match);
  if (!found || !match.table) return null;
  if (!found.state.rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) return null;
  const chars = [...found.before], after = chars.slice(0, match.start).join("") + replacement + chars.slice(match.end).join("");
  const rows = found.state.rows.map((row) => [...row]);
  rows[match.table.row][match.table.col] = after;
  return { ...found, after, rows };
}

/** Check the actual encoded frame on an isolated replica before applying a cell write. */
export function preflightTableFindReplace(doc: Doc, match: FindMatch, replacement: string): "ok" | "stale" | "size" | "preflight" {
  if (replacement.length > REPLACEMENT_LIMIT || new TextEncoder().encode(replacement).length > REPLACEMENT_LIMIT) return "size";
  if (!resolveTableFindMatch(doc, match)) return "stale";
  try {
    const state = doc.encodeState();
    if (state.byteLength > STATE_LIMIT) return "size";
    const copy = Doc.fromState(doc.client, state), rebound = { ...match, doc: copy }, plan = planTableFindReplace(copy, rebound, replacement);
    if (!plan) return "stale";
    if (plan.before === plan.after) return "ok";
    const tx = new Tx(copy); writeTable(tx, rebound.block, plan.state.props, plan.rows, copy.client);
    return tx.ops.length && encodeClientMsg({ type: "ops", batch: encodeOps(tx.ops) }).byteLength > FRAME_LIMIT ? "size" : "ok";
  } catch { return "preflight"; }
}
