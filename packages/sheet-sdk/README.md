# @jiange/sheet-sdk

Headless code shared by Jiange's experimental sheet preview: TSV codec, cell/selection operations, a bounded formula subset, and same-page copy translation. Its default grid is 100 rows by 26 columns and it is not yet connected to the workbook store. It has no XLSX reader/writer, styles, persistence, permissions, or realtime collaboration. Do not use it as a complete Excel-compatible SDK.

Build with `pnpm --filter @jiange/sheet-sdk build`; `pnpm pack` emits ESM and TypeScript declarations. The package remains private.
