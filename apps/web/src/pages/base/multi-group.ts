import type { BaseRecord, Field, User, ViewConfig } from "@/lib/api";
import { t } from "@/lib/i18n";
import {
  displayValue,
  formatAutonumber,
  formatCurrency,
  memberName,
  optionColor,
  parseLocation,
  personIDs,
} from "./registry";

export const MAX_GROUP_LEVELS = 3;

export interface GroupNode {
  /** Unique hierarchical path key across levels, used for independent collapse state. */
  pathKey: string;
  /** Grouping field for this level. */
  field: Field;
  /** 0-based depth (0 = 1st level, 1 = 2nd level, 2 = 3rd level). */
  depth: number;
  /** Raw grouping value key (empty string means ungrouped). */
  key: string;
  /** Formatted display label (empty string means render "未分组"). */
  label: string;
  /** Optional [bg, fg] palette colors for select/multi_select badges. */
  color: [string, string] | null;
  /** Records belonging to this group node (including all nested descendants). */
  records: BaseRecord[];
  /** Nested child groups (non-empty when depth + 1 < total levels). */
  children: GroupNode[];
}

/**
 * Resolve effective ordered grouping field IDs (max 3), staying backwards-compatible
 * with legacy single-field `cfg.group`.
 */
export function resolveGroupFieldIds(
  cfg: Pick<ViewConfig, "group" | "groups">,
  fields: readonly Field[],
): number[] {
  const validIds = new Set(fields.map((f) => f.id));
  const raw = cfg.groups && cfg.groups.length > 0
    ? cfg.groups
    : cfg.group
      ? [cfg.group]
      : [];
  const out: number[] = [];
  for (const id of raw) {
    if (validIds.has(id) && !out.includes(id)) {
      out.push(id);
      if (out.length === MAX_GROUP_LEVELS) break;
    }
  }
  return out;
}

/**
 * Produce an updated ViewConfig with normalized `groups` (max 3, unique) AND
 * legacy `group` kept synchronized with `groups[0]`.
 */
export function withGroupsConfig(cfg: ViewConfig, rawGroupIds: readonly number[]): ViewConfig {
  const next: number[] = [];
  for (const id of rawGroupIds) {
    if (Number.isSafeInteger(id) && id > 0 && !next.includes(id)) {
      next.push(id);
      if (next.length === MAX_GROUP_LEVELS) break;
    }
  }
  const out: ViewConfig = { ...cfg };
  if (next.length === 0) {
    delete out.group;
    delete out.groups;
  } else {
    out.group = next[0];
    out.groups = next;
  }
  return out;
}

function formatGroupLabel(field: Field, key: string, members: User[]): string {
  if (!key) return "";
  switch (field.type) {
    case "person":
    case "created_by":
      return memberName(Number(key), members) || t("成员 #{id}", { id: key });
    case "checkbox":
      return key === "true" ? t("已勾选") : t("未勾选");
    case "currency": {
      const n = Number(key);
      return Number.isFinite(n) ? formatCurrency(n, field) : key;
    }
    case "progress": {
      const n = Number(key);
      return Number.isFinite(n) ? `${Math.round(n)}%` : key;
    }
    case "autonumber": {
      const n = Number(key);
      return Number.isFinite(n) ? formatAutonumber(n, field) : key;
    }
    case "location":
      return parseLocation(key).address || key;
    default:
      return key;
  }
}

function recordKeysForField(rec: BaseRecord, field: Field, members: User[]): string[] {
  const raw = displayValue(rec, field, members);
  if (field.type === "person") {
    const ids = personIDs(raw);
    return ids.length > 0 ? ids.map(String) : [""];
  }
  if (field.type === "multi_select" && Array.isArray(raw)) {
    const tags = raw.filter((x): x is string => typeof x === "string" && x.length > 0);
    return tags.length > 0 ? tags : [""];
  }
  if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
    return [""];
  }
  return [String(raw)];
}

/**
 * Build a recursive nested grouping tree (up to 3 levels) over `records`.
 */
export function buildGroupTree(
  records: readonly BaseRecord[],
  groupFields: readonly Field[],
  members: User[],
): GroupNode[] {
  if (groupFields.length === 0) return [];

  const buildLevel = (rows: readonly BaseRecord[], depth: number, parentPath: string): GroupNode[] => {
    const field = groupFields[depth];
    const order: string[] = [];
    const buckets = new Map<string, BaseRecord[]>();
    const push = (k: string, r: BaseRecord) => {
      let arr = buckets.get(k);
      if (!arr) {
        arr = [];
        buckets.set(k, arr);
        order.push(k);
      }
      arr.push(r);
    };
    for (const r of rows) {
      for (const k of recordKeysForField(r, field, members)) {
        push(k, r);
      }
    }
    if ((field.type === "select" || field.type === "multi_select") && field.options?.length) {
      const optIdx = new Map(field.options.map((o, idx) => [o, idx]));
      order.sort((a, b) => {
        if (a === "" && b === "") return 0;
        if (a === "") return 1;
        if (b === "") return -1;
        return (optIdx.get(a) ?? 9999) - (optIdx.get(b) ?? 9999);
      });
    }

    return order.map((key) => {
      const groupRows = buckets.get(key) ?? [];
      const segment = `${field.id}:${key}`;
      const pathKey = parentPath ? `${parentPath}/${segment}` : segment;
      const color = (field.type === "select" || field.type === "multi_select") && key
        ? optionColor(field, key)
        : null;
      return {
        pathKey,
        field,
        depth,
        key,
        label: formatGroupLabel(field, key, members),
        color,
        records: groupRows,
        children: depth + 1 < groupFields.length ? buildLevel(groupRows, depth + 1, pathKey) : [],
      };
    });
  };

  return buildLevel(records, 0, "");
}
