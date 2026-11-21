# @jiange/base-sdk

Zero-dependency AI-native headless Multidimensional Base / Bitable SDK (`v0.2.0`): multi-table relational schemas across **18 field types**, topological `[Field]` formula engine (**35 built-in functions** + `#CYCLE` detection), cross-table `link`/`lookup`, view query engine, dashboard aggregator, RFC 4180 CSV/TSV with type inference, and self-describing AI tools.

## Install

```bash
npm install @jiange/base-sdk
```

- **Runtime dependencies**: `0` (completely standalone — does not even require `@jiange/ooxml`)
- **Bundle size**: ~14.7 KB gzip

## Features

- **`Base` Facade**: `Base.create`, `fromJSON`, `fromCsv`, table/field/view/record CRUD, `version` tracking, `undo()`/`redo()`, token-budgeted `inspect()`, `query()` / `queryView()`, atomic `apply(ops, { dryRun, atomic })`, and `verify()`.
- **18 Field Types**: `text`, `number`, `select`, `checkbox`, `date`, `multi_select`, `person`, `attachment`, `created_by`, `created_at`, `modified_at`, `url`, `phone`, `email`, `rating`, `formula`, `link`, `lookup`.
- **Topological `[Field]` Formula Engine**: 35 built-in functions (`SUM`, `AVERAGE`, `IF`, `IFS`, `CONCATENATE`, `CONTAINS`, `ROUND`, `DATE`/`YEAR`/`MONTH`/`DAY`, etc.) with automatic dependency resolution and `#CYCLE` detection.
- **View Query & Conditional Fills**: 11 filter operators (`eq`, `neq`, `contains`, `not_contains`, `gt`, `gte`, `lt`, `lte`, `is_empty`, `is_not_empty`, `in`), AND/OR rule groups, multi-column sort, grouping, conditional row fills (`matchFillRule`), and selection statistics (`computeSelectionStats`).
- **Headless Dashboard Aggregator**: `metric`, `bar`, `horizontal_bar`, `pie`, `line`, and `pivot` widgets (`computeMetricSummary`, `computeGroupedSeries`, `defaultDashboardWidgets`).
- **Self-Describing AI Toolkit (`createBaseTools`)**: 8 JSON-Schema tools (`base_inspect`, `base_query`, `base_apply`, `base_verify`, `base_dashboard`, `base_export_csv`, `base_undo`, `base_redo`).

## Quickstart

```ts
import { Base, createBaseTools } from "@jiange/base-sdk";

const base = Base.create({ name: "CRM Pipeline", defaultTableName: "Deals" });
const tools = createBaseTools(base);

tools.execute("base_apply", {
  ops: [
    { op: "addField", field: { name: "Amount", type: "number" } },
    { op: "addField", field: { name: "Probability", type: "number" } },
    { op: "addField", field: { name: "Weighted", type: "formula", formula: "[Amount]*[Probability]" } },
    { op: "addRecord", cells: { Name: "Acme Corp", Amount: 50000, Probability: 0.8 } },
    { op: "addRecord", cells: { Name: "Globex", Amount: 30000, Probability: 0.5 } },
  ],
});

const queried = base.query({ search: "Acme" });
const summary = base.inspect({ detail: "standard" });
const csv = base.toCsv();
const issues = base.verify();
void [queried, summary, csv, issues];
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@jiange/base-sdk` | Full barrel export (`Base`, `createBaseTools`, formulas, query, dashboard, CSV, types) |
| `@jiange/base-sdk/base` | `Base`, `BaseOp`, `BaseDiagnostic`, `BaseInspectResult`, `BaseApplyResult` |
| `@jiange/base-sdk/ai-tools` | `createBaseTools` |
| `@jiange/base-sdk/formula` | `FUNCS` (35 functions), `parseFormula`, `evalFormula`, `evalRecordFormulas`, `formulaRefs`, `formulaValid`, `FormulaError` |
| `@jiange/base-sdk/query` | `queryRecords`, `evaluateFilterRule`, `matchFillRule`, `computeSelectionStats`, `formatCellText`, `isCellEmpty` |
| `@jiange/base-sdk/dashboard` | `computeMetricSummary`, `computeGroupedSeries`, `defaultDashboardWidgets`, `DASHBOARD_PALETTE`, `isGroupableField`, `isNumericField` |
| `@jiange/base-sdk/csv` | `exportTableToCsv`, `parseCsvToTableData`, `parseDelimitedRows` |
| `@jiange/base-sdk/types` | `FieldType`, `BaseTable`, `BaseField`, `BaseRecord`, `BaseView`, `BaseSnapshot`, `DashboardWidget`, `FilterRule`, `FillRule` |

## Documentation

Full SDK documentation and recipes are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/headless-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
