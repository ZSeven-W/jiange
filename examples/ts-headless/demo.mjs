/**
 * Jiange AI-Native Headless SDK End-to-End Demo (Node.js ESM, zero browser, zero Canvas 2D).
 *
 * Run inside the monorepo:
 *   pnpm --filter @jiange/collab exec tsx ../../examples/ts-headless/demo.mjs
 */

import assert from "node:assert/strict";
import { Workbook, createSheetTools } from "../../packages/sheet-sdk/src/index.ts";
import { Document, createDocTools } from "../../packages/doc-sdk/src/index.ts";
import { Presentation, createSlidesTools } from "../../packages/slides-sdk/src/index.ts";
import { Board, createWhiteboardTools } from "../../packages/whiteboard-sdk/src/index.ts";
import { Base, createBaseTools } from "../../packages/base-sdk/src/index.ts";

// 1. Sheet: CSV -> AI dryRun -> apply -> incremental recalc -> verify -> DEFLATE XLSX
const wb = Workbook.fromCsv("Product,Units,UnitPrice\nPro,120,49\nEnterprise,25,299\n", "Q4");
const sheetTools = createSheetTools(wb);
const dry = sheetTools.execute("sheet_apply", {
  dryRun: true,
  ops: [
    {
      op: "setCells",
      sheet: "Q4",
      cells: [
        { a1: "D1", raw: "Revenue" },
        { a1: "D2", raw: "=B2*C2" },
        { a1: "D3", raw: "=B3*C3" },
        { a1: "D4", raw: "=SUM(D2:D3)" },
      ],
    },
  ],
});
assert.equal(dry.ok, true);
assert.equal(wb.sheet("Q4").getValue("D4"), null); // dryRun did not mutate

const applied = sheetTools.execute("sheet_apply", {
  ops: [
    {
      op: "setCells",
      sheet: "Q4",
      cells: [
        { a1: "D1", raw: "Revenue" },
        { a1: "D2", raw: "=B2*C2" },
        { a1: "D3", raw: "=B3*C3" },
        { a1: "D4", raw: "=SUM(D2:D3)" },
      ],
    },
  ],
});
assert.equal(applied.ok, true);
assert.equal(wb.sheet("Q4").getValue("D4"), 13355);
assert.equal(wb.verify().length, 0);
const xlsxBytes = await wb.toXlsxAsync();
assert.ok(xlsxBytes.byteLength > 0);

// 2. Doc: Markdown -> AI inspect -> DOCX
const doc = Document.fromMarkdown("# Q4 Launch Plan\n\nTotal Q4 revenue reached $13,355.\n");
const docTools = createDocTools(doc);
const docInspect = docTools.execute("doc_inspect", { detail: "outline" });
assert.equal(docInspect.summary.headingCount, 1);
const docxBytes = await doc.toDocxAsync();
assert.ok(docxBytes.byteLength > 0);

// 3. Slides: Create deck -> AI apply -> SVG render -> PPTX
const deck = Presentation.create({ title: "Q4 Executive Review" });
const slidesTools = createSlidesTools(deck);
slidesTools.execute("slides_apply", {
  ops: [
    {
      op: "addSlide",
      title: "Q4 Revenue Highlights",
      body: "Pro: $5,880 | Enterprise: $7,475 | Total: $13,355",
      layout: "title",
    },
  ],
});
const svg = deck.renderSvg(0);
assert.ok(svg.includes("<svg"));
const pptxBytes = await deck.toPptxAsync();
assert.ok(pptxBytes.byteLength > 0);

// 4. Whiteboard: Mermaid -> Auto-layout -> Topology verify -> SVG
const board = Board.fromMermaid("flowchart TD\n  A[Client] --> B[API Gateway]\n  B --> C[Jiange SDK]\n");
const boardTools = createWhiteboardTools(board);
const boardAudit = boardTools.execute("board_verify", {});
assert.equal(boardAudit.filter((i) => i.severity === "error").length, 0);
assert.ok(board.toSvg().includes("<svg"));
const boardInfo = board.inspect();

// 5. Base: Relational table -> AI record mutation -> Query & Dashboard
const base = Base.create({ name: "Deal Pipeline" });
const baseTools = createBaseTools(base);
baseTools.execute("base_apply", {
  ops: [
    { op: "addRecord", cells: { Name: "Acme Corp", Amount: 7475 } },
    { op: "addRecord", cells: { Name: "Globex", Amount: 5880 } },
  ],
});
assert.equal(base.getRecords().length, 2);

console.log(
  JSON.stringify(
    {
      ok: true,
      sheetRevenueD4: wb.sheet("Q4").getValue("D4"),
      xlsxBytes: xlsxBytes.byteLength,
      docxBytes: docxBytes.byteLength,
      pptxBytes: pptxBytes.byteLength,
      boardNodes: boardInfo.nodeCount,
      baseRecords: base.getRecords().length,
    },
    null,
    2,
  ),
);
