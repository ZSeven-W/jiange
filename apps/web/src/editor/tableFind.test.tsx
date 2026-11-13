import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager, idKey } from "@jiange/collab";
import { renderToStaticMarkup } from "react-dom/server";
import { findDocumentMatches, planTableFindReplace, preflightTableFindReplace, resolveTableFindMatch } from "./tableFind";
import { applyTableFindReplace } from "./tableFindApply";
import { applyTableHistory } from "./tableHistoryUndo";
import { TableCellHistory } from "./tableCellHistory";
import { tableRowsOf, writeTable } from "./tableCells";
import { TableBlock, tableFindText } from "./TableBlock";

function setup() {
  const doc = new Doc(7), tx = new Tx(doc), text = tx.create("paragraph", null, ROOT);
  tx.insert(text, 0, "正文目标");
  const table = tx.create("table", text, ROOT, { tableData: JSON.stringify([["目标😀目标", "隐藏目标"], ["目标方案", "其他"]]), tableMerges: JSON.stringify([[0, 0, 1, 2]]) });
  const last = tx.create("paragraph", table, ROOT); tx.insert(last, 0, "结束目标");
  return { doc, table };
}

describe("find in document tables", () => {
  it("includes only visible cells in document order, using code point offsets", () => {
    const { doc } = setup(), matches = findDocumentMatches(doc, "目标");
    expect(matches.map((m) => m.table ? `table:${m.table.row}:${m.table.col}:${m.start}` : "text")).toEqual(["text", "table:0:0:0", "table:0:0:3", "table:1:0:0", "text"]);
    expect(matches[2].text).toBe("目标");
  });

  it("rejects stale structure, values, same-value writes and other replicas", () => {
    const { doc, table } = setup(), match = findDocumentMatches(doc, "目标")[1];
    expect(resolveTableFindMatch(doc, match)).not.toBeNull();
    expect(resolveTableFindMatch(doc, { ...match, start: -1 })).toBeNull();
    expect(resolveTableFindMatch(Doc.fromState(8, doc.encodeState()), match)).toBeNull();
    doc.setProp(table, "tableData", doc.blockInfo(table).props.tableData);
    expect(resolveTableFindMatch(doc, match)).toBeNull();
    const again = findDocumentMatches(doc, "目标")[1];
    new Tx(doc).setProp(table, "tableMerges", "[]");
    expect(resolveTableFindMatch(doc, again)).toBeNull();
  });

  it("does not crash on malformed cell data or replace by rewriting malformed rows", () => {
    const doc = new Doc(1), tx = new Tx(doc);
    tx.create("table", null, ROOT, { tableData: JSON.stringify([["目标", 9], null]) });
    const matches = findDocumentMatches(doc, "目标");
    expect(matches).toHaveLength(1);
    const before = doc.encodeState();
    expect(preflightTableFindReplace(doc, matches[0], "新内容")).toBe("stale");
    expect(doc.encodeState()).toEqual(before);
  });

  it("preflights on a clone and replaces one cell with guarded undo and redo", () => {
    const { doc, table } = setup(), match = findDocumentMatches(doc, "目标")[2], before = doc.encodeState();
    expect(preflightTableFindReplace(doc, match, "完成")).toBe("ok");
    expect(preflightTableFindReplace(doc, match, "x".repeat((1 << 20) + 1))).toBe("size");
    expect(doc.encodeState()).toEqual(before);
    expect(planTableFindReplace(doc, match, "完成")?.after).toBe("目标😀完成");
    const session = {}, undo = new UndoManager(), history = new TableCellHistory();
    const result = applyTableFindReplace(doc, session, undo, history, match, "完成");
    expect(result.status).toBe("replaced");
    expect(result.ops.length).toBeGreaterThan(0);
    expect(tableRowsOf(doc.blockInfo(table).props)[0][0]).toBe("目标😀完成");
    const key = `table:${idKey(table)}:0:0`;
    expect(applyTableHistory(doc, session, undo, history, key, false).status).toBe("ready");
    expect(tableRowsOf(doc.blockInfo(table).props)[0][0]).toBe("目标😀目标");
    expect(applyTableHistory(doc, session, undo, history, key, true).status).toBe("ready");
    expect(tableRowsOf(doc.blockInfo(table).props)[0][0]).toBe("目标😀完成");
    const info = doc.blockInfo(table), rows = tableRowsOf(info.props); rows[0][0] = "协作者修改";
    writeTable(new Tx(doc), table, info.props, rows, doc.client);
    expect(applyTableHistory(doc, session, undo, history, key, false).status).toBe("conflict");
    expect(tableRowsOf(doc.blockInfo(table).props)[0][0]).toBe("协作者修改");
  });

  it("marks matched and active cells without making hidden cells visible", () => {
    const html = renderToStaticMarkup(<TableBlock data={JSON.stringify([["目标", "隐藏"], ["其他", "目标"]])} merges={JSON.stringify([[0, 0, 1, 2]])} findCells={[{ row: 0, col: 0, value: "目标", ranges: [{ start: 0, end: 2, active: true }] }, { row: 1, col: 1, value: "目标", ranges: [{ start: 0, end: 2, active: false }] }]} readOnly onEdit={() => {}} onDelete={() => {}} />);
    expect(html).toContain('data-find-active="true"');
    expect((html.match(/data-find-match="true"/g) ?? [])).toHaveLength(2);
    expect(html).not.toContain("隐藏");
  });

  it("highlights exact Unicode ranges and ignores stale or overlapping ranges", () => {
    const html = renderToStaticMarkup(<>{tableFindText("前😀目标与目标后", [{ start: 2, end: 4, active: true }, { start: 3, end: 5, active: false }, { start: 5, end: 7, active: false }, { start: -1, end: 1, active: false }])}</>);
    expect(html).toContain('data-table-find-fragment="active"');
    expect(html).toContain('data-table-find-fragment="match"');
    expect(html.replace(/<[^>]+>/g, "")).toBe("前😀目标与目标后");
    expect((html.match(/<mark/g) ?? [])).toHaveLength(2);
    const stale = renderToStaticMarkup(<TableBlock data={JSON.stringify([["已修改"]])} findCells={[{ row: 0, col: 0, value: "旧目标", ranges: [{ start: 1, end: 3, active: true }] }]} readOnly onEdit={() => {}} onDelete={() => {}} />);
    expect(stale).not.toContain('data-find-active="true"');
    expect(stale).not.toContain("<mark");
  });

  it("keeps the editable textarea and an inaccessible visual-only highlight layer", () => {
    const html = renderToStaticMarkup(<TableBlock data={JSON.stringify([["前目标后"]])} findCells={[{ row: 0, col: 0, value: "前目标后", ranges: [{ start: 1, end: 3, active: true }] }]} readOnly={false} onEdit={() => {}} onDelete={() => {}} />);
    expect(html).toContain('aria-hidden="true" data-table-find-overlay');
    expect(html).toContain('data-table-find-fragment="active"');
    expect(html).toMatch(/<textarea[^>]*data-table-cell="0:0"[^>]*>前目标后<\/textarea>/);
    expect(html).toContain("text-transparent");
  });
});
