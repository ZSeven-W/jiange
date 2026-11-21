export type FieldType =
  | "text"
  | "number"
  | "select"
  | "checkbox"
  | "date"
  | "multi_select"
  | "person"
  | "attachment"
  | "created_by"
  | "created_at"
  | "modified_at"
  | "url"
  | "phone"
  | "email"
  | "rating"
  | "formula"
  | "link"
  | "lookup";

export interface BaseTable {
  id: number;
  baseId: number;
  name: string;
  position: number;
  isDefault: boolean;
}

export interface AttachmentRef {
  id: number;
  name: string;
  mime: string;
  size: number;
}

export type BaseCell = string | number | boolean | string[] | number[] | AttachmentRef[];

export interface BaseField {
  id: number;
  tableId: number;
  targetTableId?: number;
  /** For `lookup` fields: the `link` field id on this table. */
  linkFieldId?: number;
  /** For `lookup` fields: the target field id on the linked table. */
  lookupFieldId?: number;
  name: string;
  type: FieldType;
  isPrimary?: boolean;
  description?: string;
  options?: string[];
  optionColors?: number[];
  formula?: string;
  position: number;
  multiple?: boolean;
  defaultValue?: BaseCell | null;
}

export interface BaseRecord {
  id: number;
  baseId: number;
  tableId: number;
  cells: Record<string, BaseCell>;
  position: number;
  creatorId?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type FilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is_empty"
  | "is_not_empty"
  | "in";

export interface FilterRule {
  f: number;
  op: FilterOp | (string & {});
  v?: string | number | boolean | number[] | string[];
}

export interface FillRule extends FilterRule {
  color: number;
}

export type RowHeight = "low" | "medium" | "high" | "xhigh";

export interface ViewConfig {
  title?: string;
  desc?: string;
  fields?: number[];
  required?: number[];
  filters?: { conj: "and" | "or"; rules: FilterRule[] };
  sorts?: { f: number; asc: boolean }[];
  group?: number;
  endField?: number;
  hidden?: number[];
  locked?: boolean;
  configLocked?: boolean;
  rowHeight?: RowHeight;
  fills?: FillRule[];
  frozen?: number;
  card?: { fields?: number[]; cover?: number | null };
}

export type BaseViewType = "grid" | "kanban" | "gallery" | "calendar" | "form" | "gantt";

export interface BaseView {
  id: number;
  baseId: number;
  tableId: number;
  type: BaseViewType;
  name: string;
  config: ViewConfig;
  pos: number;
}

export type DashboardWidgetType = "metric" | "bar" | "horizontal_bar" | "pie" | "line" | "pivot";
export type DashboardMetric = "count" | "sum" | "avg" | "min" | "max" | "checked_pct";

export interface DashboardWidget {
  id: string;
  type: DashboardWidgetType;
  title: string;
  tableId?: number;
  span: 1 | 2;
  groupFieldId?: number;
  metric: DashboardMetric;
  valueFieldId?: number;
}

export interface BaseDashboard {
  id: number;
  baseId: number;
  name: string;
  widgets: DashboardWidget[];
  revision: number;
  updatedAt: string;
}

export interface BaseSnapshot {
  name: string;
  tables: BaseTable[];
  fields: BaseField[];
  records: BaseRecord[];
  views: BaseView[];
}
