/**
 * Formal domain types and AI-Native contract types for `@jiange/sheet-sdk`.
 * Structurally compatible with Jiange's server & web workbook APIs while
 * remaining 100% transport-, UI-, and framework-agnostic.
 */

export interface SheetBorders {
  top?: boolean;
  right?: boolean;
  bottom?: boolean;
  left?: boolean;
  color?: string;
}

export type SheetNumFmt =
  | ""
  | "general"
  | "currency"
  | "percent"
  | "decimal2"
  | "decimal1"
  | "integer"
  | "date"
  | (string & {});

export interface SheetCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  bg?: string;
  align?: "left" | "center" | "right" | "";
  valign?: "top" | "middle" | "bottom" | "";
  wrap?: boolean;
  borders?: SheetBorders;
  numFmt?: SheetNumFmt;
}

export interface SheetStylePatch {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  bg?: string;
  align?: "" | "left" | "center" | "right";
  valign?: "" | "top" | "middle" | "bottom";
  wrap?: boolean;
  borders?: SheetBorders;
  clearBorders?: boolean;
  numFmt?: SheetNumFmt;
}

export interface SheetMerge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface SheetRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface SheetColumnFilter {
  query?: string;
  values?: string[];
}

export interface SheetSortRule {
  col: number;
  ascending: boolean;
}

export interface SheetFilterConfig {
  enabled?: boolean;
  headerRow?: number;
  rules?: Record<string, SheetColumnFilter>;
  sort?: SheetSortRule;
}

export interface SheetAxis {
  id: number;
  pos: number;
  size?: number;
}

export interface SheetCell {
  rowId: number;
  columnId: number;
  raw: string;
  style?: SheetCellStyle;
  revision: number;
}

export interface SheetDataValidation {
  id: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  type: "list" | "number" | "date";
  options?: string[];
  min?: string;
  max?: string;
  strict: boolean;
  hint?: string;
}

export type SheetCondFormatOp =
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "eq"
  | "neq"
  | "between"
  | "contains"
  | "empty"
  | "not_empty";

export interface SheetConditionalFormat {
  id: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  op: SheetCondFormatOp;
  value1?: string;
  value2?: string;
  bg?: string;
  color?: string;
  bold?: boolean;
}

export interface SheetProtectedRange {
  id: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  description?: string;
  allowedUserIds?: number[];
}

export interface SheetComment {
  id: number;
  nodeId?: number;
  worksheetId: number;
  rowId: number;
  columnId: number;
  authorId?: number;
  authorName: string;
  body: string;
  resolved: boolean;
  resolvedBy?: number;
  resolvedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SheetHyperlink {
  row: number;
  col: number;
  target: string;
  tooltip?: string;
}

export interface SheetDefinedName {
  name: string;
  ref: string;
  /** Optional worksheet scope; omit for workbook-global name. */
  sheetName?: string;
}

export type SheetChartType = "column" | "bar" | "line" | "area" | "pie";

export interface SheetChart {
  id: string;
  title: string;
  type: SheetChartType;
  top: number;
  left: number;
  bottom: number;
  right: number;
  headerRow: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  showLegend: boolean;
  showValues?: boolean;
}

export type SheetPivotAgg = "sum" | "count" | "avg" | "min" | "max";
export type SheetPivotSort = "" | "label_asc" | "label_desc" | "value_desc" | "value_asc";

export interface SheetPivotValue {
  col: number;
  agg: SheetPivotAgg;
}

export interface SheetPivotTable {
  id: string;
  title: string;
  sourceSheetId?: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
  rowFields: number[];
  colField?: number;
  values: SheetPivotValue[];
  showRowTotals: boolean;
  showColTotals: boolean;
  sortBy?: SheetPivotSort;
  destRow?: number;
  destCol?: number;
}

export interface SheetWorksheet {
  id: number;
  nodeId: number;
  title: string;
  pos: number;
  frozenRows: number;
  frozenCols: number;
  merges: SheetMerge[];
  filter: SheetFilterConfig;
  validations?: SheetDataValidation[];
  conditionalFormats?: SheetConditionalFormat[];
  protectedRanges?: SheetProtectedRange[];
  charts?: SheetChart[];
  pivotTables?: SheetPivotTable[];
  hyperlinks?: SheetHyperlink[];
  comments?: SheetComment[];
  revision: number;
  rows: SheetAxis[];
  columns: SheetAxis[];
  cells: SheetCell[];
}

export interface SheetSnapshot {
  nodeId: number;
  workspaceId: number;
  parentId: number | null;
  title: string;
  role: string;
  creatorId: number;
  creatorName: string;
  driveRevision: number;
  workbookRevision: number;
  sheets: SheetWorksheet[];
  definedNames?: SheetDefinedName[];
  updatedAt: string;
}

export interface SheetCellWrite {
  rowId: number;
  columnId: number;
  expectedRevision: number;
  raw?: string;
  style?: SheetCellStyle;
  stylePatch?: SheetStylePatch;
}

export interface SheetCellRevision {
  rowId: number;
  columnId: number;
  revision: number;
  raw?: string;
  style?: SheetCellStyle;
  merged?: boolean;
}

export interface SheetCellConflict {
  rowId: number;
  columnId: number;
  row: number;
  col: number;
  expectedRevision: number;
  currentRevision: number;
  currentRaw: string;
  currentStyle?: SheetCellStyle;
  attemptedRaw?: string;
  attemptedStyle?: SheetCellStyle;
  attemptedStylePatch?: SheetStylePatch;
  conflictingFields?: string[];
  reason: "value_conflict" | "style_conflict" | "merge_slave_conflict";
  updatedBy?: number;
  updatedByName?: string;
  mergeRect?: SheetMerge;
  anchorRowId?: number;
  anchorColumnId?: number;
  anchorRaw?: string;
  anchorRevision?: number;
}

export interface ImportedSheetCell {
  row: number;
  col: number;
  raw: string;
  style?: SheetCellStyle;
}

export interface ImportedWorksheet {
  title: string;
  rows: number;
  cols: number;
  cells: ImportedSheetCell[];
  merges?: SheetMerge[];
  frozenRows?: number;
  frozenCols?: number;
  colWidths?: Record<number, number>;
  rowHeights?: Record<number, number>;
  validations?: SheetDataValidation[];
  conditionalFormats?: SheetConditionalFormat[];
  hyperlinks?: SheetHyperlink[];
}

export type EvalValue =
  | { kind: "empty"; value: ""; error?: undefined }
  | { kind: "number"; value: number; error?: undefined }
  | { kind: "string"; value: string; error?: undefined }
  | { kind: "boolean"; value: boolean; error?: undefined }
  | { kind: "error"; value: string; error: string }
  | { kind: "array"; value: EvalValue[][]; error?: undefined };

export type EvaluatedSheetMap = Record<string, EvalValue>;

export interface FormulaRefHighlight {
  sheetId: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
  color: string;
  text: string;
}

// ---------- AI-Native structural contract ----------

export type InspectDetail = "outline" | "summary" | "full";

export interface InspectOptions {
  detail?: InspectDetail;
  maxTokens?: number;
  focus?: string;
  cursor?: string;
}

export interface InspectResult<TSummary = unknown> {
  kind: "sheet";
  version: number;
  promptText: string;
  summary: TSummary;
  estimatedTokens: number;
  truncated: boolean;
  nextCursor?: string;
}

export interface ApplyOptions {
  dryRun?: boolean;
  atomic?: boolean;
  actor?: { kind: "ai" | "user" | "system"; id?: string; reason?: string };
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  target: string;
  message: string;
  suggestion?: string;
}

export interface ApplyResult<TDiff = unknown> {
  ok: boolean;
  dryRun: boolean;
  appliedCount: number;
  diff: TDiff;
  diagnostics: Diagnostic[];
  undoToken?: string;
  error?: { index: number; code: string; message: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentToolkit {
  readonly tools: readonly ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<unknown> | unknown;
}
