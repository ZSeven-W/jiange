# @zseven-w/sheet-sdk

AI-native headless Spreadsheet engine (`v0.2.0`): incremental AST + DAG formula engine (**144 Excel functions** + dynamic arrays + Web Worker protocol), bounded DEFLATE XLSX / CSV / TSV I/O, data validations, conditional formatting, charts, pivot tables, and self-describing AI tools.

Independently installable with zero UI, framework, or cross-domain SDK bloat.

## Install

```bash
npm install @zseven-w/sheet-sdk
```

- **Runtime dependencies**: `@zseven-w/ooxml` (0 third-party dependencies)
- **Bundle size**: ~72.6 KB gzip

## Features

- **AI-Native `Workbook` Facade**: `Workbook.create`, `fromXlsx`, `fromCsv`, `fromTsv`, `fromSnapshot`, token-budgeted `inspect()`, targeted `query()`, atomic `apply(ops, { dryRun })` with diff + `undoToken`, deterministic `verify()`, and built-in `undo()`/`redo()`.
- **Self-Describing AI Toolkit (`createSheetTools`)**: 6 JSON-Schema tools (`sheet_inspect`, `sheet_query`, `sheet_apply`, `sheet_verify`, `sheet_undo`, `sheet_export_csv`) ready for OpenAI, Gemini, Anthropic, and MCP.
- **Incremental AST + DAG Formula Engine (`144` built-in functions)**:
  - Math, stats, conditional aggregation (`SUMIFS`, `COUNTIFS`, `AVERAGEIFS`, `MAXIFS`, `MINIFS`, `SUMPRODUCT`), lookup & reference (`VLOOKUP`, `HLOOKUP`, `XLOOKUP`, `INDEX`, `MATCH`, `XMATCH`, `OFFSET`, `INDIRECT`, `TRANSPOSE`), logic, text, date/time, financial (`PMT`, `PV`, `FV`, `NPV`, `IRR`, `RATE`, `NPER`), and dynamic arrays (`FILTER`, `SORT`, `SORTBY`, `UNIQUE`, `SEQUENCE`) with `#SPILL!` tracking.
  - Whole-column/row refs (`A:A`, `1:1`), `defineName()`, custom `registerFunction()`, bidirectional `getPrecedents()`/`getDependents()`, and runtime-agnostic Worker protocol (`createFormulaWorkerHost` / `FormulaWorkerClient`).
- **OOXML XLSX, CSV & TSV**: Sync `writeXlsx` (STORE) and async `writeXlsxAsync` (DEFLATE + `sharedStrings.xml`), shared-formula expansion on read, styles, `numfmt`, merges, frozen panes, row/col sizes, defined names, data validations, conditional formats, hyperlinks, comments, and configurable safety limits.
- **Rules, Analytics & Collaboration Helpers**: Data validation, 10-operator conditional formatting, protected ranges, chart extraction, pivot table materialization, and remote delta patching.

## Quickstart

```ts
import { Workbook, createSheetTools, SUPPORTED_FORMULA_FUNCTIONS } from "@zseven-w/sheet-sdk";

const wb = Workbook.fromCsv("Item,Qty,Price\nPro,120,49\nEnterprise,25,299\n", "Sales");
const tools = createSheetTools(wb);

// Dry-run preview before mutating
const preview = tools.execute("sheet_apply", {
  dryRun: true,
  ops: [
    {
      op: "setCells",
      sheet: "Sales",
      cells: [
        { a1: "D1", raw: "Revenue" },
        { a1: "D2", raw: "=B2*C2" },
        { a1: "D3", raw: "=B3*C3" },
        { a1: "D4", raw: "=SUM(D2:D3)" },
      ],
    },
  ],
});

// Commit atomically, verify zero formula errors, and export DEFLATE XLSX
tools.execute("sheet_apply", {
  ops: [
    {
      op: "setCells",
      sheet: "Sales",
      cells: [
        { a1: "D1", raw: "Revenue" },
        { a1: "D2", raw: "=B2*C2" },
        { a1: "D3", raw: "=B3*C3" },
        { a1: "D4", raw: "=SUM(D2:D3)" },
      ],
    },
  ],
});

console.log(wb.sheet("Sales").getValue("D4")); // 13355
console.log(wb.verify().length, SUPPORTED_FORMULA_FUNCTIONS.length); // 0, 144
const xlsxBytes = await wb.toXlsxAsync();
void [preview, xlsxBytes];
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@zseven-w/sheet-sdk` | Full barrel export (`Workbook`, `createSheetTools`, formulas, XLSX, CSV/TSV, rules, analytics, worker) |
| `@zseven-w/sheet-sdk/workbook` | `Workbook`, `WorksheetProxy`, `WorkbookOp`, `WorkbookInspectSummary` |
| `@zseven-w/sheet-sdk/ai-tools` | `createSheetTools` |
| `@zseven-w/sheet-sdk/formula-engine` | `IncrementalFormulaEngine`, `calculateWorkbook`, `evalScalarRaw`, sorting/filtering helpers |
| `@zseven-w/sheet-sdk/formula-functions` | `SUPPORTED_FORMULA_FUNCTIONS` (144 Excel functions) |
| `@zseven-w/sheet-sdk/formula-ast` | Formula tokenizer & AST parser |
| `@zseven-w/sheet-sdk/formula` | Legacy `calculateSheet`, `translateSheetFormula` |
| `@zseven-w/sheet-sdk/worker` | `createFormulaWorkerHost`, `FormulaWorkerClient` |
| `@zseven-w/sheet-sdk/xlsx` / `./xlsx-read` / `./workbook-xlsx` | `writeXlsx`, `writeXlsxAsync`, `readXlsx`, `XlsxError`, `resolveXlsxLimits` *(deprecated alias: `./xlsxRead`)* |
| `@zseven-w/sheet-sdk/csv` / `./tsv` / `./numfmt` / `./clipboard` | RFC 4180 CSV, TSV, Excel number formatter, clipboard codec |
| `@zseven-w/sheet-sdk/rules` / `./analytics` / `./collab` / `./grid` / `./types` | Data validation, conditional format, charts, pivots, collab delta helpers, A1 grid math, types |

## Documentation

Full SDK documentation, benchmarks, and AI tool schemas are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/headless-sdks.md` and `sdk-docs/ai-native-protocol.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
