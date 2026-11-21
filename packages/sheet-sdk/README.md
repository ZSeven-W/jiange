# @jiange/sheet-sdk

Lightweight, zero-DOM, AI-native headless spreadsheet SDK for Node.js, Edge runtimes, Web Workers, and browsers. Depends only on `@jiange/ooxml` (zero third-party runtime dependencies).

## Capabilities

- **AI-Native `Workbook` Facade (`@jiange/sheet-sdk/workbook`, `@jiange/sheet-sdk/ai-tools`)**:
  - `Workbook.create()`, `Workbook.fromSnapshot()`, `Workbook.fromXlsx()`, `Workbook.fromCsv()`, `Workbook.fromTsv()`.
  - Token-budgeted semantic inspection (`wb.inspect({ detail, maxTokens, focus, cursor })`), targeted queries (`wb.query`), declarative atomic batch patching with dry-run & diff (`wb.apply(ops, { dryRun })`), deterministic auditing (`wb.verify()`), and built-in undo/redo.
  - Self-describing JSON Schema tool definitions and executor (`createSheetTools(wb)`) ready for OpenAI, Gemini, Anthropic, and MCP tool calling.
- **Incremental AST + DAG Formula Engine (`@jiange/sheet-sdk/formula-engine`, `/formula-ast`, `/formula-functions`, `/worker`)**:
  - 130+ Excel functions across math, statistics, conditional aggregations (`SUMIFS`, `COUNTIFS`, `AVERAGEIFS`, `MAXIFS`, `MINIFS`, `SUMPRODUCT`), lookup & reference (`VLOOKUP`, `HLOOKUP`, `XLOOKUP`, `INDEX`, `MATCH`, `XMATCH`, `OFFSET`, `INDIRECT`, `TRANSPOSE`), logic, text, date/time, financial (`PMT`, `PV`, `FV`, `NPV`, `IRR`, `RATE`, `NPER`), and dynamic arrays (`FILTER`, `SORT`, `SORTBY`, `UNIQUE`, `SEQUENCE`) with `#SPILL!` tracking.
  - Whole-column/row references (`A:A`, `1:1`), named ranges (`definedNames`), custom function registration (`registerFunction`), bidirectional precedent/dependent graph with range watchers for dirty-subgraph incremental recalculation, and a runtime-agnostic Worker protocol (`createFormulaWorkerHost` / `FormulaWorkerClient`).
- **Rules, Analytics & Collaboration Primitives (`@jiange/sheet-sdk/rules`, `/analytics`, `/collab`)**:
  - Data validation, 10-operator conditional formatting, protected range checks, chart dataset extraction, multi-dimensional pivot table computation & materialization, field-level style patches, remote delta patching, and conflict resolution helpers.
- **Bounded OOXML XLSX, CSV & TSV I/O (`@jiange/sheet-sdk/xlsx`, `/xlsx-read`, `/workbook-xlsx`, `/csv`, `/tsv`)**:
  - Sync `writeXlsx` (STORE) and async `writeXlsxAsync` (DEFLATE + `sharedStrings.xml` deduplication), multi-sheet cells, formulas, shared-formula expansion on read, ISO dates, styles, number formats (`numfmt`), merges, frozen panes, column widths, row heights, defined names, data validations, hyperlinks, configurable safety limits, and explicit format-loss `warnings`.

Build `@jiange/ooxml` first, then `pnpm --filter @jiange/sheet-sdk build`; `pnpm pack` emits ESM and TypeScript declarations.

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See `LICENSE` (bundled in the package archive; repository root `LICENSE`) for full terms.
