# Changelog — @jiange/sheet-sdk

## [0.2.0] - 2026-11-21

### Added & Changed
- Extracted full workbook engine, rules, analytics, charts, pivot tables, collab merge, and XLSX I/O into standalone zero-DOM SDK.
- Added AST + DAG incremental formula engine supporting 125+ Excel functions, dynamic arrays, defined names, custom functions, and Web Worker adapter (`./worker`).
- Added high-level `Workbook` AI-Native facade (`inspect`, `query`, `apply(dryRun)`, `verify`, `createSheetTools`), CSV/TSV interop, and XLSX styles/widths/heights/validations/conditional formats/comments/hyperlinks.
- Achieved 100% V8 unit test coverage.
