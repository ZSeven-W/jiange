import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Building2, Plus, ShieldCheck, Trash2, User as UserIcon, Users } from "lucide-react";
import { FeishuSelect } from "@/components/feishu-select";
import type {
  BasePermissionRole,
  BaseRecord,
  Field,
  FilterRule,
  OrgDepartment,
  OrgGroup,
  User,
  ViewConfig,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { TypeGlyph } from "./cells";
import { popupPosition } from "./popup-position";

export type FieldPermission = "edit" | "readonly" | "hidden";
export type RoleRowScope = "all" | "own" | "filter";

export interface ViewPermissionsConfig {
  /** Per-field permission override. Missing entries default to "edit". */
  fields: Record<number, FieldPermission>;
  /** When true, only records created by the active user are visible. */
  onlyOwnRows: boolean;
  /** Optional Feishu-style custom RBAC roles targeting users, departments, or groups. */
  roles?: BasePermissionRole[];
}

export const DEFAULT_VIEW_PERMISSIONS: ViewPermissionsConfig = {
  fields: {},
  onlyOwnRows: false,
};

const VALID_FIELD_PERMS = new Set<string>(["edit", "readonly", "hidden"]);
const VALID_ROW_SCOPES = new Set<string>(["all", "own", "filter"]);
const MAX_ROLES = 32;

const ROLE_OP_LABELS: Record<string, string> = {
  contains: "包含",
  not_contains: "不包含",
  is: "等于",
  is_not: "不等于",
  empty: "为空",
  not_empty: "不为空",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  checked: "已勾选",
  unchecked: "未勾选",
};

const NO_VALUE_OPS = new Set(["empty", "not_empty", "checked", "unchecked"]);
const NON_FILTERABLE_TYPES = new Set([
  "link",
  "lookup",
  "formula",
  "created_by",
  "created_at",
  "modified_at",
  "attachment",
]);

function roleOpsFor(type: string): string[] {
  switch (type) {
    case "number":
    case "rating":
      return ["is", "is_not", "gt", "gte", "lt", "lte", "empty", "not_empty"];
    case "checkbox":
      return ["checked", "unchecked"];
    case "date":
      return ["is", "is_not", "gt", "gte", "lt", "lte", "empty", "not_empty"];
    case "select":
      return ["is", "is_not", "empty", "not_empty"];
    case "person":
      return ["contains", "not_contains", "empty", "not_empty"];
    default:
      return ["contains", "not_contains", "is", "is_not", "empty", "not_empty"];
  }
}

function dedupePositiveIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of ids) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function normalizeRole(raw: BasePermissionRole, fallbackIdx: number): BasePermissionRole {
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 64) : `role-${fallbackIdx + 1}`;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 64) : `角色 ${fallbackIdx + 1}`;
  const userIds = dedupePositiveIds(raw.userIds);
  const deptIds = dedupePositiveIds(raw.deptIds);
  const groupIds = dedupePositiveIds(raw.groupIds);
  const canAddRecord = raw.canAddRecord !== false;
  const canDeleteRecord = raw.canDeleteRecord !== false;
  const rowScope: RoleRowScope = typeof raw.rowScope === "string" && VALID_ROW_SCOPES.has(raw.rowScope)
    ? (raw.rowScope as RoleRowScope)
    : "all";
  const fieldModes: Record<string, FieldPermission> = {};
  if (raw.fieldModes && typeof raw.fieldModes === "object") {
    for (const [k, v] of Object.entries(raw.fieldModes)) {
      const fid = Number(k);
      if (Number.isSafeInteger(fid) && fid > 0 && typeof v === "string" && VALID_FIELD_PERMS.has(v) && v !== "edit") {
        fieldModes[String(fid)] = v as FieldPermission;
      }
    }
  }
  let rowFilters: BasePermissionRole["rowFilters"];
  if (rowScope === "filter" && raw.rowFilters && Array.isArray(raw.rowFilters.rules) && raw.rowFilters.rules.length > 0) {
    const conj = raw.rowFilters.conj === "or" ? "or" : "and";
    const rules = raw.rowFilters.rules.filter(
      (r): r is FilterRule => !!r && Number.isSafeInteger(r.f) && r.f > 0 && typeof r.op === "string" && r.op.length > 0,
    );
    if (rules.length > 0) {
      rowFilters = { conj, rules };
    }
  }
  return {
    id,
    name,
    ...(userIds.length > 0 ? { userIds } : {}),
    ...(deptIds.length > 0 ? { deptIds } : {}),
    ...(groupIds.length > 0 ? { groupIds } : {}),
    canAddRecord,
    canDeleteRecord,
    rowScope,
    ...(rowFilters ? { rowFilters } : {}),
    ...(Object.keys(fieldModes).length > 0 ? { fieldModes } : {}),
    ...(raw.viewHidden ? { viewHidden: true } : {}),
  };
}

/** Convert cloud-persisted ViewConfig.permissions into the panel's normalized ViewPermissionsConfig. */
export function viewPermissionsFromConfig(
  perms: ViewConfig["permissions"] | undefined,
): ViewPermissionsConfig {
  if (!perms || typeof perms !== "object") {
    return { fields: {}, onlyOwnRows: false };
  }
  const fields: Record<number, FieldPermission> = {};
  if (perms.fieldModes && typeof perms.fieldModes === "object") {
    for (const [k, v] of Object.entries(perms.fieldModes)) {
      const fid = Number(k);
      if (Number.isSafeInteger(fid) && fid > 0 && typeof v === "string" && VALID_FIELD_PERMS.has(v) && v !== "edit") {
        fields[fid] = v as FieldPermission;
      }
    }
  }
  const roles = Array.isArray(perms.roles)
    ? perms.roles
        .filter((r): r is BasePermissionRole => !!r && typeof r === "object")
        .slice(0, MAX_ROLES)
        .map((r, idx) => normalizeRole(r, idx))
    : [];
  return {
    fields,
    onlyOwnRows: perms.onlyOwnRecords === true,
    ...(roles.length > 0 ? { roles } : {}),
  };
}

/** Serialize ViewPermissionsConfig into cloud-persisted ViewConfig.permissions (or undefined if empty). */
export function viewPermissionsToConfig(
  config: ViewPermissionsConfig,
): ViewConfig["permissions"] | undefined {
  const fieldModes: Record<string, FieldPermission> = {};
  for (const [k, v] of Object.entries(config.fields)) {
    const fid = Number(k);
    if (Number.isSafeInteger(fid) && fid > 0 && (v === "readonly" || v === "hidden")) {
      fieldModes[String(fid)] = v;
    }
  }
  const roles = (config.roles ?? [])
    .slice(0, MAX_ROLES)
    .map((r, idx) => normalizeRole(r, idx));
  const hasFieldModes = Object.keys(fieldModes).length > 0;
  if (!config.onlyOwnRows && !hasFieldModes && roles.length === 0) {
    return undefined;
  }
  return {
    ...(config.onlyOwnRows ? { onlyOwnRecords: true } : {}),
    ...(hasFieldModes ? { fieldModes } : {}),
    ...(roles.length > 0 ? { roles } : {}),
  };
}

/** Intersect multiple view permission policies (hidden > readonly > edit; onlyOwnRows OR'd). */
export function mergeViewPermissions(
  configs: readonly ViewPermissionsConfig[],
): ViewPermissionsConfig {
  const fields: Record<number, FieldPermission> = {};
  let onlyOwnRows = false;
  for (const cfg of configs) {
    if (cfg.onlyOwnRows) onlyOwnRows = true;
    for (const [k, v] of Object.entries(cfg.fields)) {
      const fid = Number(k);
      if (!Number.isSafeInteger(fid) || fid <= 0) continue;
      if (v === "hidden" || (v === "readonly" && fields[fid] !== "hidden")) {
        fields[fid] = v;
      }
    }
  }
  return { fields, onlyOwnRows };
}

export function fieldPermissionOf(config: ViewPermissionsConfig, fieldId: number): FieldPermission {
  return config.fields[fieldId] ?? "edit";
}

export function countActiveViewPermissions(
  config: ViewPermissionsConfig,
  fields: readonly Pick<Field, "id">[],
): number {
  const validIds = new Set(fields.map((f) => f.id));
  let count = config.onlyOwnRows ? 1 : 0;
  for (const [k, perm] of Object.entries(config.fields)) {
    if (validIds.has(Number(k)) && (perm === "readonly" || perm === "hidden")) count++;
  }
  count += config.roles?.length ?? 0;
  return count;
}

/**
 * Project fields and records through the active view's fine-grained permissions:
 * - "hidden" fields are excluded from `visibleFields` and collected in `hiddenFieldIds`.
 * - "readonly" fields remain visible and are collected in `readonlyFieldIds`.
 * - `onlyOwnRows` restricts `records` to those with `creatorId === userId`.
 */
export function applyViewPermissions(
  fields: readonly Field[],
  records: readonly BaseRecord[],
  config: ViewPermissionsConfig,
  userId: number,
): {
  visibleFields: Field[];
  readonlyFieldIds: Set<number>;
  hiddenFieldIds: Set<number>;
  records: BaseRecord[];
} {
  const readonlyFieldIds = new Set<number>();
  const hiddenFieldIds = new Set<number>();
  const visibleFields: Field[] = [];

  for (const field of fields) {
    const perm = fieldPermissionOf(config, field.id);
    if (perm === "hidden") {
      hiddenFieldIds.add(field.id);
      continue;
    }
    if (perm === "readonly") {
      readonlyFieldIds.add(field.id);
    }
    visibleFields.push(field);
  }

  const filteredRecords = config.onlyOwnRows
    ? records.filter((rec) => rec.creatorId === userId)
    : [...records];

  return {
    visibleFields,
    readonlyFieldIds,
    hiddenFieldIds,
    records: filteredRecords,
  };
}

function roleSubjectCount(role: BasePermissionRole): number {
  return (role.userIds?.length ?? 0) + (role.deptIds?.length ?? 0) + (role.groupIds?.length ?? 0);
}

function defaultRuleForField(field: Field, members: readonly User[]): FilterRule {
  const op = roleOpsFor(field.type)[0] ?? "contains";
  if (field.type === "person") {
    return { f: field.id, op, v: members[0]?.id ? [members[0].id] : [] };
  }
  if (field.type === "select" && field.options?.length) {
    return { f: field.id, op, v: field.options[0] };
  }
  if (field.type === "number" || field.type === "rating") {
    return { f: field.id, op, v: 0 };
  }
  if (field.type === "checkbox") {
    return { f: field.id, op };
  }
  return { f: field.id, op, v: "" };
}

export function ViewPermissionsPanel({
  fields,
  value,
  onChange,
  members = [],
  departments = [],
  groups = [],
  disabled = false,
  defaultOpen = false,
  defaultTab = "default",
}: {
  fields: Field[];
  value: ViewPermissionsConfig;
  onChange: (next: ViewPermissionsConfig) => void;
  members?: User[];
  departments?: OrgDepartment[];
  groups?: OrgGroup[];
  disabled?: boolean;
  defaultOpen?: boolean;
  defaultTab?: "default" | "roles";
}) {
  const { t } = useI18n();
  const permPills: readonly { value: FieldPermission; label: string }[] = [
    { value: "edit", label: t("可编辑") },
    { value: "readonly", label: t("仅只读") },
    { value: "hidden", label: t("隐藏") },
  ];
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<"default" | "roles">(defaultTab);
  const roles = value.roles ?? [];
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(() => roles[0]?.id ?? null);
  const triggerWrapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof popupPosition> | null>(null);

  const activeCount = countActiveViewPermissions(value, fields);
  const filterableFields = useMemo(() => {
    const filtered = fields.filter((f) => !NON_FILTERABLE_TYPES.has(f.type));
    return filtered.length > 0 ? filtered : fields;
  }, [fields]);

  const activeRole = useMemo(() => {
    if (roles.length === 0) return null;
    return roles.find((r) => r.id === selectedRoleId) ?? roles[0];
  }, [roles, selectedRoleId]);

  useEffect(() => {
    if (roles.length === 0) {
      if (selectedRoleId !== null) setSelectedRoleId(null);
      return;
    }
    if (!selectedRoleId || !roles.some((r) => r.id === selectedRoleId)) {
      setSelectedRoleId(roles[0].id);
    }
  }, [roles, selectedRoleId]);

  const panelWidth = tab === "roles" ? 456 : 384;

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerWrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition(popupPosition(rect, window.innerWidth, window.innerHeight, panelWidth, 540));
    };
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerWrapRef.current?.contains(target) ||
        bodyRef.current?.contains(target) ||
        (target instanceof Element && target.closest('[role="listbox"]'))
      ) {
        return;
      }
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    place();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, panelWidth]);

  const setFieldPerm = (fieldId: number, perm: FieldPermission) => {
    if (disabled) return;
    const nextFields = { ...value.fields };
    if (perm === "edit") delete nextFields[fieldId];
    else nextFields[fieldId] = perm;
    onChange({ ...value, fields: nextFields });
  };

  const setRoles = (nextRoles: BasePermissionRole[]) => {
    if (disabled) return;
    if (nextRoles.length === 0) {
      const { roles: _removed, ...rest } = value;
      onChange(rest);
      return;
    }
    onChange({ ...value, roles: nextRoles });
  };

  const addRole = () => {
    if (disabled || roles.length >= MAX_ROLES) return;
    const existingIds = new Set(roles.map((r) => r.id));
    let n = roles.length + 1;
    let id = `role-${Date.now().toString(36)}-${n}`;
    while (existingIds.has(id)) {
      n++;
      id = `role-${Date.now().toString(36)}-${n}`;
    }
    const created: BasePermissionRole = {
      id,
      name: t("角色 {n}", { n: roles.length + 1 }),
      canAddRecord: true,
      canDeleteRecord: true,
      rowScope: "all",
    };
    setRoles([...roles, created]);
    setSelectedRoleId(id);
    setTab("roles");
  };

  const updateRole = (roleId: string, updater: (role: BasePermissionRole) => BasePermissionRole) => {
    if (disabled) return;
    setRoles(roles.map((r) => (r.id === roleId ? updater(r) : r)));
  };

  const deleteRole = (roleId: string) => {
    if (disabled) return;
    const next = roles.filter((r) => r.id !== roleId);
    setRoles(next);
    if (selectedRoleId === roleId) {
      setSelectedRoleId(next[0]?.id ?? null);
    }
  };

  const toggleRoleSubject = (
    role: BasePermissionRole,
    key: "userIds" | "deptIds" | "groupIds",
    subjectId: number,
  ) => {
    if (disabled) return;
    updateRole(role.id, (cur) => {
      const prev = cur[key] ?? [];
      const next = prev.includes(subjectId)
        ? prev.filter((id) => id !== subjectId)
        : [...prev, subjectId];
      const updated = { ...cur };
      if (next.length > 0) updated[key] = next;
      else delete updated[key];
      return updated;
    });
  };

  const setRoleFieldPerm = (role: BasePermissionRole, fieldId: number, perm: FieldPermission) => {
    if (disabled) return;
    updateRole(role.id, (cur) => {
      const nextModes = { ...(cur.fieldModes ?? {}) };
      const k = String(fieldId);
      if (perm === "edit") delete nextModes[k];
      else nextModes[k] = perm;
      const updated = { ...cur };
      if (Object.keys(nextModes).length > 0) updated.fieldModes = nextModes;
      else delete updated.fieldModes;
      return updated;
    });
  };

  const setRoleRowScope = (role: BasePermissionRole, scope: RoleRowScope) => {
    if (disabled) return;
    updateRole(role.id, (cur) => {
      const updated: BasePermissionRole = { ...cur, rowScope: scope };
      if (scope === "filter") {
        if (!cur.rowFilters || cur.rowFilters.rules.length === 0) {
          const firstField = filterableFields[0];
          updated.rowFilters = {
            conj: "and",
            rules: firstField ? [defaultRuleForField(firstField, members)] : [],
          };
        }
      } else {
        delete updated.rowFilters;
      }
      return updated;
    });
  };

  const setRoleFilters = (role: BasePermissionRole, rules: FilterRule[], conj?: "and" | "or") => {
    if (disabled) return;
    updateRole(role.id, (cur) => {
      const nextConj = conj ?? cur.rowFilters?.conj ?? "and";
      const updated = { ...cur };
      if (rules.length > 0) updated.rowFilters = { conj: nextConj, rules };
      else delete updated.rowFilters;
      return updated;
    });
  };

  const renderFieldPermissionRows = (
    getMode: (fieldId: number) => FieldPermission,
    onSetMode: (fieldId: number, perm: FieldPermission) => void,
    rowAttr: string,
  ) => (
    <div className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
      {fields.map((field) => {
        const current = getMode(field.id);
        return (
          <div
            key={field.id}
            className="flex items-center justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 hover:border-[#ebedf0] hover:bg-hover/40"
            {...{ [rowAttr]: field.id }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="shrink-0 text-muted-foreground">
                <TypeGlyph t={field.type} size={13} />
              </span>
              <span className="truncate text-[13px]" title={field.name}>
                {field.name}
              </span>
            </span>
            <div
              role="radiogroup"
              aria-label={t("{name} 字段权限", { name: field.name })}
              className="inline-flex shrink-0 rounded-md border border-[#dee0e3] bg-[#f5f6f7] p-0.5 text-[11px] dark:bg-sidebar"
            >
              {permPills.map((pill) => {
                const active = current === pill.value;
                const hideDisabled = disabled || (pill.value === "hidden" && !!field.isPrimary);
                return (
                  <button
                    key={pill.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={hideDisabled}
                    title={pill.value === "hidden" && field.isPrimary ? t("主字段不能隐藏") : undefined}
                    onClick={() => onSetMode(field.id, pill.value)}
                    data-perm-state={pill.value}
                    className={cn(
                      "h-6 rounded px-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                      active
                        ? pill.value === "hidden"
                          ? "bg-surface text-destructive shadow-xs"
                          : pill.value === "readonly"
                            ? "bg-surface text-amber-600 shadow-xs"
                            : "bg-surface text-primary shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {pill.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {fields.length === 0 && (
        <p className="py-4 text-center text-[12px] text-subtle">{t("暂无字段")}</p>
      )}
    </div>
  );

  const panelBody = (
    <div
      ref={bodyRef}
      role="dialog"
      aria-label={t("字段与行权限")}
      style={position ? { ...position, width: panelWidth } : undefined}
      className={cn(
        "z-[105] max-w-[calc(100vw-24px)] rounded-lg border border-[#dee0e3] bg-surface p-3.5 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.14)]",
        tab === "roles" ? "w-[456px]" : "w-[384px]",
        position ? "fixed max-h-[calc(100vh-32px)] overflow-y-auto" : "absolute right-0 top-9",
      )}
      data-view-perms-panel
    >
      <div className="flex items-center justify-between gap-2 pb-2.5">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <ShieldCheck size={15} className="text-primary" aria-hidden />
          <span>{t("字段与行权限")}</span>
        </div>
        {activeCount > 0 && !disabled && (
          <button
            type="button"
            onClick={() => onChange({ fields: {}, onlyOwnRows: false })}
            className="rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
            data-view-perms-reset
          >
            {t("重置")}
          </button>
        )}
      </div>

      {/* Segmented tabs: 默认规则 | 自定义角色 (N) */}
      <div
        role="tablist"
        aria-label={t("权限配置模式")}
        className="mb-3 grid grid-cols-2 rounded-md border border-[#dee0e3] bg-[#f5f6f7] p-0.5 text-[12px] dark:bg-sidebar"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "default"}
          data-perms-tab="default"
          onClick={() => setTab("default")}
          className={cn(
            "h-7 rounded font-medium transition-colors",
            tab === "default"
              ? "bg-surface text-primary shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("默认规则")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "roles"}
          data-perms-tab="roles"
          onClick={() => setTab("roles")}
          className={cn(
            "flex h-7 items-center justify-center gap-1 rounded font-medium transition-colors",
            tab === "roles"
              ? "bg-surface text-primary shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span>{t("自定义角色")}</span>
          <span className="text-[11px] opacity-80">({roles.length})</span>
        </button>
      </div>

      {tab === "default" ? (
        <>
          <div className="rounded-md border border-[#e5e6eb] bg-[#f7f8fa]/70 p-2.5 dark:bg-sidebar/50">
            <div className="mb-1 text-[11px] font-medium text-subtle">{t("行权限")}</div>
            <label className="flex cursor-pointer items-start gap-2 text-[13px]" data-view-perms-own-rows>
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-primary"
                checked={value.onlyOwnRows}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, onlyOwnRows: e.target.checked })}
              />
              <span className="min-w-0">
                <span className="block font-medium text-foreground">{t("仅查看自己创建的记录")}</span>
                <span className="block text-[11px] text-muted-foreground">{t("开启后仅显示本人创建的记录")}</span>
              </span>
            </label>
          </div>

          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-subtle">
              <span>{t("字段权限")}</span>
              <span>{t("{n} 个字段", { n: fields.length })}</span>
            </div>
            {renderFieldPermissionRows(
              (fid) => fieldPermissionOf(value, fid),
              setFieldPerm,
              "data-view-perm-field",
            )}
          </div>
        </>
      ) : (
        <div className="space-y-3" data-rbac-roles-pane>
          {/* Role selector chips + add role button */}
          <div className="flex flex-wrap items-center gap-1.5" data-role-list>
            {roles.map((role) => {
              const selected = activeRole?.id === role.id;
              const subjectCount = roleSubjectCount(role);
              return (
                <button
                  key={role.id}
                  type="button"
                  data-role-item={role.id}
                  onClick={() => setSelectedRoleId(role.id)}
                  className={cn(
                    "inline-flex h-7 max-w-[160px] items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors",
                    selected
                      ? "border-primary bg-[#edf2ff] text-primary dark:bg-accent"
                      : "border-[#dee0e3] bg-surface text-muted-foreground hover:bg-hover hover:text-foreground",
                  )}
                >
                  <span className="truncate">{role.name}</span>
                  <span
                    className={cn(
                      "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px]",
                      selected ? "bg-primary/15 text-primary" : "bg-[#f0f1f2] text-subtle dark:bg-sidebar",
                    )}
                    data-role-subject-count={role.id}
                  >
                    {subjectCount}
                  </span>
                </button>
              );
            })}
            {!disabled && roles.length < MAX_ROLES && (
              <button
                type="button"
                onClick={addRole}
                data-add-role
                className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-[#c9cdd4] px-2 text-[12px] font-medium text-primary hover:border-primary hover:bg-[#edf2ff]/50"
              >
                <Plus size={13} strokeWidth={2} />
                <span>{t("新建角色")}</span>
              </button>
            )}
          </div>

          {!activeRole ? (
            <div className="rounded-md border border-dashed border-[#dee0e3] bg-[#f7f8fa]/60 px-3 py-6 text-center dark:bg-sidebar/40">
              <p className="text-[12px] text-muted-foreground">
                {t("按成员、部门或用户组配置多角色高级权限，未命中角色的协作者遵循默认规则")}
              </p>
              {!disabled && (
                <button
                  type="button"
                  onClick={addRole}
                  className="mt-2.5 inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-[12px] font-medium text-white hover:bg-primary-hover"
                >
                  <Plus size={13} strokeWidth={2} />
                  <span>{t("新建角色")}</span>
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3 rounded-md border border-[#e5e6eb] bg-[#fafbfc] p-2.5 dark:bg-sidebar/30" data-role-editor={activeRole.id}>
              {/* Role name + delete */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={activeRole.name}
                  maxLength={64}
                  disabled={disabled}
                  aria-label={t("角色名称")}
                  placeholder={t("输入角色名称")}
                  data-role-name-input
                  onChange={(e) =>
                    updateRole(activeRole.id, (cur) => ({ ...cur, name: e.target.value }))
                  }
                  className="h-8 min-w-0 flex-1 rounded-md border border-[#dee0e3] bg-surface px-2.5 text-[13px] font-medium outline-none focus:border-primary disabled:opacity-60"
                />
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => deleteRole(activeRole.id)}
                    title={t("删除角色")}
                    aria-label={t("删除角色")}
                    data-role-delete
                    className="grid size-8 shrink-0 place-items-center rounded-md border border-[#dee0e3] bg-surface text-muted-foreground hover:border-destructive/40 hover:text-destructive"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>

              {/* Target subjects: members, departments, user groups */}
              <div className="space-y-2 rounded-md border border-[#ebedf0] bg-surface p-2">
                <div className="flex items-center justify-between text-[11px] font-medium text-subtle">
                  <span>{t("适用成员 / 部门 / 用户组")}</span>
                  <span>{t("已选 {n} 项", { n: roleSubjectCount(activeRole) })}</span>
                </div>
                {members.length === 0 && departments.length === 0 && groups.length === 0 ? (
                  <p className="py-1 text-[11px] text-subtle">{t("暂无可选成员或组织")}</p>
                ) : (
                  <div className="max-h-28 space-y-2 overflow-y-auto pr-0.5">
                    {members.length > 0 && (
                      <div>
                        <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                          <UserIcon size={11} />
                          <span>{t("成员")}</span>
                        </div>
                        <div className="flex flex-wrap gap-1" data-role-member-pills>
                          {members.map((m) => {
                            const selected = activeRole.userIds?.includes(m.id) ?? false;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                disabled={disabled}
                                aria-pressed={selected}
                                data-role-user-pill={m.id}
                                onClick={() => toggleRoleSubject(activeRole, "userIds", m.id)}
                                className={cn(
                                  "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors disabled:opacity-50",
                                  selected
                                    ? "border-primary bg-[#edf2ff] font-medium text-primary dark:bg-accent"
                                    : "border-[#e5e6eb] bg-[#f7f8fa] text-foreground hover:bg-hover dark:bg-sidebar",
                                )}
                              >
                                <span className="max-w-[110px] truncate">{m.name || m.email}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {departments.length > 0 && (
                      <div>
                        <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Building2 size={11} />
                          <span>{t("部门")}</span>
                        </div>
                        <div className="flex flex-wrap gap-1" data-role-dept-pills>
                          {departments.map((d) => {
                            const selected = activeRole.deptIds?.includes(d.id) ?? false;
                            return (
                              <button
                                key={d.id}
                                type="button"
                                disabled={disabled}
                                aria-pressed={selected}
                                data-role-dept-pill={d.id}
                                onClick={() => toggleRoleSubject(activeRole, "deptIds", d.id)}
                                className={cn(
                                  "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors disabled:opacity-50",
                                  selected
                                    ? "border-primary bg-[#edf2ff] font-medium text-primary dark:bg-accent"
                                    : "border-[#e5e6eb] bg-[#f7f8fa] text-foreground hover:bg-hover dark:bg-sidebar",
                                )}
                              >
                                <span className="max-w-[120px] truncate">{d.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {groups.length > 0 && (
                      <div>
                        <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Users size={11} />
                          <span>{t("用户组")}</span>
                        </div>
                        <div className="flex flex-wrap gap-1" data-role-group-pills>
                          {groups.map((g) => {
                            const selected = activeRole.groupIds?.includes(g.id) ?? false;
                            return (
                              <button
                                key={g.id}
                                type="button"
                                disabled={disabled}
                                aria-pressed={selected}
                                data-role-group-pill={g.id}
                                onClick={() => toggleRoleSubject(activeRole, "groupIds", g.id)}
                                className={cn(
                                  "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors disabled:opacity-50",
                                  selected
                                    ? "border-primary bg-[#edf2ff] font-medium text-primary dark:bg-accent"
                                    : "border-[#e5e6eb] bg-[#f7f8fa] text-foreground hover:bg-hover dark:bg-sidebar",
                                )}
                              >
                                <span className="max-w-[120px] truncate">{g.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Action & view toggles */}
              <div className="grid grid-cols-3 gap-1.5 rounded-md border border-[#ebedf0] bg-surface p-2 text-[12px]">
                <label className="flex cursor-pointer items-center gap-1.5" data-role-can-add>
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={activeRole.canAddRecord !== false}
                    disabled={disabled}
                    onChange={(e) =>
                      updateRole(activeRole.id, (cur) => ({ ...cur, canAddRecord: e.target.checked }))
                    }
                  />
                  <span className="truncate">{t("允许新增记录")}</span>
                </label>
                <label className="flex cursor-pointer items-center gap-1.5" data-role-can-delete>
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={activeRole.canDeleteRecord !== false}
                    disabled={disabled}
                    onChange={(e) =>
                      updateRole(activeRole.id, (cur) => ({ ...cur, canDeleteRecord: e.target.checked }))
                    }
                  />
                  <span className="truncate">{t("允许删除记录")}</span>
                </label>
                <label className="flex cursor-pointer items-center gap-1.5" data-role-view-hidden>
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={!!activeRole.viewHidden}
                    disabled={disabled}
                    onChange={(e) =>
                      updateRole(activeRole.id, (cur) => {
                        const updated = { ...cur };
                        if (e.target.checked) updated.viewHidden = true;
                        else delete updated.viewHidden;
                        return updated;
                      })
                    }
                  />
                  <span className="truncate">{t("隐藏此视图")}</span>
                </label>
              </div>

              {/* Row scope selector via FeishuSelect */}
              <div className="space-y-2 rounded-md border border-[#ebedf0] bg-surface p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-subtle">{t("可访问记录范围")}</span>
                  <FeishuSelect
                    ariaLabel={t("可访问记录范围")}
                    value={activeRole.rowScope ?? "all"}
                    disabled={disabled}
                    options={[
                      { value: "all", label: t("全部记录") },
                      { value: "own", label: t("仅本人创建") },
                      { value: "filter", label: t("按条件筛选") },
                    ]}
                    onChange={(val) => setRoleRowScope(activeRole, val as RoleRowScope)}
                    className="h-7 border border-[#dee0e3] bg-surface px-2 text-[12px]"
                    chevronSize={11}
                    menuMinWidth={128}
                    dataAttr={{ "data-role-row-scope": true }}
                  />
                </div>

                {activeRole.rowScope === "filter" && (() => {
                  const rf = activeRole.rowFilters ?? { conj: "and" as const, rules: [] };
                  return (
                    <div className="space-y-1.5 border-t border-[#f0f1f2] pt-2" data-role-row-filters>
                      {rf.rules.length > 1 && (
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span>{t("满足")}</span>
                          <FeishuSelect
                            ariaLabel={t("筛选组合方式")}
                            value={rf.conj}
                            disabled={disabled}
                            options={[
                              { value: "and", label: t("全部条件（且）") },
                              { value: "or", label: t("任一条件（或）") },
                            ]}
                            onChange={(val) => setRoleFilters(activeRole, rf.rules, val as "and" | "or")}
                            className="h-6 border border-[#dee0e3] bg-surface px-1.5 text-[11px]"
                            chevronSize={10}
                            menuMinWidth={118}
                          />
                        </div>
                      )}
                      {rf.rules.map((rule, idx) => {
                        const field = filterableFields.find((f) => f.id === rule.f) ?? filterableFields[0];
                        const ops = roleOpsFor(field?.type ?? "text");
                        const opValue = ops.includes(rule.op) ? rule.op : ops[0];
                        return (
                          <div key={idx} className="flex items-center gap-1" data-role-filter-rule={idx}>
                            <FeishuSelect
                              ariaLabel={t("筛选字段")}
                              value={String(field?.id ?? rule.f)}
                              disabled={disabled}
                              options={filterableFields.map((f) => ({ value: String(f.id), label: f.name }))}
                              onChange={(val) => {
                                const nextF = filterableFields.find((f) => f.id === Number(val));
                                if (!nextF) return;
                                const nextRules = [...rf.rules];
                                nextRules[idx] = defaultRuleForField(nextF, members);
                                setRoleFilters(activeRole, nextRules);
                              }}
                              className="h-7 w-24 border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                              chevronSize={10}
                              menuMinWidth={110}
                            />
                            <FeishuSelect
                              ariaLabel={t("筛选条件")}
                              value={opValue}
                              disabled={disabled}
                              options={ops.map((op) => ({ value: op, label: t(ROLE_OP_LABELS[op] ?? op) }))}
                              onChange={(val) => {
                                const nextRules = [...rf.rules];
                                nextRules[idx] = NO_VALUE_OPS.has(val)
                                  ? { f: field?.id ?? rule.f, op: val }
                                  : { ...rule, f: field?.id ?? rule.f, op: val };
                                setRoleFilters(activeRole, nextRules);
                              }}
                              className="h-7 w-[88px] border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                              chevronSize={10}
                              menuMinWidth={100}
                            />
                            {!NO_VALUE_OPS.has(opValue) && (
                              field?.type === "select" && field.options && field.options.length > 0 ? (
                                <FeishuSelect
                                  ariaLabel={t("筛选值")}
                                  value={String(rule.v ?? field.options[0])}
                                  disabled={disabled}
                                  options={field.options.map((o) => ({ value: o, label: o }))}
                                  onChange={(val) => {
                                    const nextRules = [...rf.rules];
                                    nextRules[idx] = { ...rule, v: val };
                                    setRoleFilters(activeRole, nextRules);
                                  }}
                                  className="h-7 min-w-0 flex-1 border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                                  chevronSize={10}
                                  menuMinWidth={104}
                                />
                              ) : field?.type === "person" && members.length > 0 ? (
                                <FeishuSelect
                                  ariaLabel={t("筛选值")}
                                  value={String(Array.isArray(rule.v) ? (rule.v[0] ?? "") : (rule.v ?? ""))}
                                  disabled={disabled}
                                  options={members.map((m) => ({ value: String(m.id), label: m.name || m.email }))}
                                  onChange={(val) => {
                                    const uid = Number(val);
                                    const nextRules = [...rf.rules];
                                    nextRules[idx] = { ...rule, v: Number.isSafeInteger(uid) && uid > 0 ? [uid] : [] };
                                    setRoleFilters(activeRole, nextRules);
                                  }}
                                  className="h-7 min-w-0 flex-1 border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                                  chevronSize={10}
                                  menuMinWidth={104}
                                />
                              ) : (
                                <input
                                  type={field?.type === "number" || field?.type === "rating" ? "number" : "text"}
                                  disabled={disabled}
                                  value={String(rule.v ?? "")}
                                  aria-label={t("筛选值")}
                                  placeholder={t("输入值")}
                                  onChange={(e) => {
                                    const nextRules = [...rf.rules];
                                    const rawVal = e.target.value;
                                    nextRules[idx] = {
                                      ...rule,
                                      v: field?.type === "number" || field?.type === "rating"
                                        ? (rawVal === "" ? 0 : Number(rawVal))
                                        : rawVal,
                                    };
                                    setRoleFilters(activeRole, nextRules);
                                  }}
                                  className="h-7 min-w-0 flex-1 rounded border border-[#dee0e3] bg-surface px-2 text-[12px] outline-none focus:border-primary"
                                />
                              )
                            )}
                            {!disabled && (
                              <button
                                type="button"
                                aria-label={t("删除条件")}
                                onClick={() => setRoleFilters(activeRole, rf.rules.filter((_, j) => j !== idx))}
                                className="px-1 text-subtle hover:text-destructive"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {!disabled && filterableFields.length > 0 && (
                        <button
                          type="button"
                          data-role-add-filter
                          onClick={() =>
                            setRoleFilters(activeRole, [...rf.rules, defaultRuleForField(filterableFields[0], members)])
                          }
                          className="inline-flex h-6 items-center gap-1 rounded px-1 text-[12px] text-primary hover:bg-hover"
                        >
                          <Plus size={12} />
                          <span>{t("添加条件")}</span>
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Per-field permissions for active role */}
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-subtle">
                  <span>{t("角色字段权限")}</span>
                  <span>{t("{n} 个字段", { n: fields.length })}</span>
                </div>
                {renderFieldPermissionRows(
                  (fid) => (activeRole.fieldModes?.[String(fid)] as FieldPermission | undefined) ?? "edit",
                  (fid, perm) => setRoleFieldPerm(activeRole, fid, perm),
                  "data-role-field-perm",
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div ref={triggerWrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-view-perms-btn
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[13px] transition-colors hover:bg-hover",
          activeCount > 0 || open ? "bg-accent font-medium text-primary" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <ShieldCheck size={14} strokeWidth={1.7} className="shrink-0" />
        <span>{t("权限配置")}</span>
        {activeCount > 0 && (
          <span
            className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-white"
            data-view-perms-count
          >
            {activeCount}
          </span>
        )}
      </button>
      {open && (typeof document !== "undefined" ? (position && createPortal(panelBody, document.body)) : panelBody)}
    </div>
  );
}
