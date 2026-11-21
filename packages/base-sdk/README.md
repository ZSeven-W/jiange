# @jiange/base-sdk

Zero-dependency AI-native headless multidimensional Base / Bitable SDK.

## Install

```bash
npm install @jiange/base-sdk
```

Zero runtime dependencies — runs in Node.js, Edge runtimes, Workers, and browsers.

## Features

- Multi-table schema & typed records (18 field types including `formula`, `link`, `lookup`, `select`, `multi_select`, `rating`, `date`)
- Topological `[Field]` formula engine with 35 built-in functions & `#CYCLE` detection
- View query engine (AND/OR filter rules, multi-column sort, grouping, conditional row fills, selection statistics)
- Headless dashboard aggregator (`metric`, `bar`, `horizontal_bar`, `pie`, `line`, `pivot`)
- RFC 4180 CSV/TSV import & export
- AI-native `Base` Facade (`inspect`, `query`, `apply(ops, { dryRun, atomic })`, `verify`, `undo`/`redo`) and `createBaseTools()`
