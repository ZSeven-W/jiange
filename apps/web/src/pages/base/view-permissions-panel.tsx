import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ShieldCheck } from "lucide-react";
import type { BaseRecord, Field } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { TypeGlyph } from "./cells";
import { popupPosition } from "./popup-position";

export type FieldPermission = "edit" | "readonly" | "hidden";

export interface ViewPermissionsConfig {
  /** Per-field permission override. Missing entries default to "edit". */
  fields: Record<number, FieldPermission>;
  /** When true, only records created by the active user are visible. */
  onlyOwnRows: boolean;
}

export const DEFAULT_VIEW_PERMISSIONS: ViewPermissionsConfig = {
  fields: {},
  onlyOwnRows: false,
};

const VALID_FIELD_PERMS = new Set<string>(["edit", "readonly", "hidden"]);

export function viewPermissionsStorageKey(baseId: number, viewId: number): string {
  return `jiange:base:view-perms:${baseId}:${viewId}`;
}

export function loadViewPermissions(
  baseId: number,
  viewId: number | null | undefined,
): ViewPermissionsConfig {
  if (!Number.isSafeInteger(baseId) || baseId <= 0 || !viewId || !Number.isSafeInteger(viewId) || viewId <= 0) {
    return { fields: {}, onlyOwnRows: false };
  }
  if (typeof localStorage === "undefined") {
    return { fields: {}, onlyOwnRows: false };
  }
  try {
    const raw = localStorage.getItem(viewPermissionsStorageKey(baseId, viewId));
    if (!raw) return { fields: {}, onlyOwnRows: false };
    const parsed = JSON.parse(raw) as { fields?: Record<string, unknown>; onlyOwnRows?: unknown };
    const fields: Record<number, FieldPermission> = {};
    if (parsed && typeof parsed === "object" && parsed.fields && typeof parsed.fields === "object") {
      for (const [k, v] of Object.entries(parsed.fields)) {
        const fid = Number(k);
        if (Number.isSafeInteger(fid) && fid > 0 && typeof v === "string" && VALID_FIELD_PERMS.has(v) && v !== "edit") {
          fields[fid] = v as FieldPermission;
        }
      }
    }
    return {
      fields,
      onlyOwnRows: parsed?.onlyOwnRows === true,
    };
  } catch {
    return { fields: {}, onlyOwnRows: false };
  }
}

export function saveViewPermissions(
  baseId: number,
  viewId: number | null | undefined,
  config: ViewPermissionsConfig,
): void {
  if (!Number.isSafeInteger(baseId) || baseId <= 0 || !viewId || !Number.isSafeInteger(viewId) || viewId <= 0) return;
  if (typeof localStorage === "undefined") return;
  try {
    const cleanedFields: Record<number, FieldPermission> = {};
    for (const [k, v] of Object.entries(config.fields)) {
      const fid = Number(k);
      if (Number.isSafeInteger(fid) && fid > 0 && (v === "readonly" || v === "hidden")) {
        cleanedFields[fid] = v;
      }
    }
    if (!config.onlyOwnRows && Object.keys(cleanedFields).length === 0) {
      localStorage.removeItem(viewPermissionsStorageKey(baseId, viewId));
    } else {
      localStorage.setItem(
        viewPermissionsStorageKey(baseId, viewId),
        JSON.stringify({ fields: cleanedFields, onlyOwnRows: !!config.onlyOwnRows }),
      );
    }
  } catch {
    // Ignore storage quota / privacy mode failures.
  }
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

export function ViewPermissionsPanel({
  fields,
  value,
  onChange,
  disabled = false,
  defaultOpen = false,
}: {
  fields: Field[];
  value: ViewPermissionsConfig;
  onChange: (next: ViewPermissionsConfig) => void;
  disabled?: boolean;
  defaultOpen?: boolean;
}) {
  const { t } = useI18n();
  const permPills: readonly { value: FieldPermission; label: string }[] = [
    { value: "edit", label: t("可编辑") },
    { value: "readonly", label: t("仅只读") },
    { value: "hidden", label: t("隐藏") },
  ];
  const [open, setOpen] = useState(defaultOpen);
  const triggerWrapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof popupPosition> | null>(null);

  const activeCount = countActiveViewPermissions(value, fields);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerWrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition(popupPosition(rect, window.innerWidth, window.innerHeight, 376, 460));
    };
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerWrapRef.current?.contains(target) || bodyRef.current?.contains(target)) return;
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
  }, [open]);

  const setFieldPerm = (fieldId: number, perm: FieldPermission) => {
    if (disabled) return;
    const nextFields = { ...value.fields };
    if (perm === "edit") delete nextFields[fieldId];
    else nextFields[fieldId] = perm;
    onChange({ ...value, fields: nextFields });
  };

  const panelBody = (
    <div
      ref={bodyRef}
      role="dialog"
      aria-label={t("字段与行权限")}
      style={position ? { ...position, width: 376 } : undefined}
      className={cn(
        "z-[105] w-[376px] max-w-[calc(100vw-24px)] rounded-lg border border-[#dee0e3] bg-surface p-3.5 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.14)]",
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
        <div className="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
          {fields.map((field) => {
            const current = fieldPermissionOf(value, field.id);
            return (
              <div
                key={field.id}
                className="flex items-center justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 hover:border-[#ebedf0] hover:bg-hover/40"
                data-view-perm-field={field.id}
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
                        onClick={() => setFieldPerm(field.id, pill.value)}
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
      </div>
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
