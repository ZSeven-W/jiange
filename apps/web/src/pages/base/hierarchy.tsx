import { useMemo, useState } from "react";
import { baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { FeishuSelect } from "@/components/feishu-select";
import { t, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CellEditor, CellView, TypeGlyph } from "./cells";
import { evalFormulas, recordTitleField, REGISTRY, setFormulaCache } from "./registry";
import { AlertTriangle, ChevronRight, ChevronsDownUp, ChevronsUpDown, Expand, GitBranch, Plus } from "lucide-react";

export interface HierarchyNode {
  record: BaseRecord;
  depth: number;
  parentId: number | null;
  children: HierarchyNode[];
  /** Total count of all nested descendants under this node. */
  descendantCount: number;
  /** True when a cyclic parent pointer on this node was automatically broken. */
  cycleBroken?: boolean;
}

export interface HierarchyTreeResult {
  roots: HierarchyNode[];
  hadCycle: boolean;
  /** IDs of nodes that have at least one child (used by Expand/Collapse All). */
  branchIds: number[];
}

/**
 * Reports whether `field` is a self-referencing link field pointing to the same base & table.
 */
export function isSelfLinkField(field: Field, baseId: number, tableId?: number): boolean {
  if (field.type !== "link") return false;
  const optBase = field.options?.[0];
  if (optBase !== undefined && optBase !== "" && Number(optBase) !== baseId) {
    return false;
  }
  if (field.targetTableId && tableId && field.targetTableId !== tableId) {
    return false;
  }
  return true;
}

/**
 * Extract the parent record ID for `record` from either server `expansions`
 * (when cells were folded to title strings) or raw numeric cell values.
 */
export function extractParentId(
  record: BaseRecord,
  parentFieldId: number,
  expansions?: Record<string, unknown>,
): number | null {
  const fidStr = String(parentFieldId);
  const expMap = expansions?.[fidStr] as Record<string, unknown> | undefined;
  const rawExp = expMap?.[String(record.id)];
  if (Array.isArray(rawExp)) {
    for (const item of rawExp) {
      const n = Number(item);
      if (Number.isSafeInteger(n) && n > 0) return n;
    }
    return null;
  }
  const rawCell = record.cells[fidStr];
  if (Array.isArray(rawCell)) {
    for (const item of rawCell) {
      if (typeof item === "number" && Number.isSafeInteger(item) && item > 0) return item;
    }
    return null;
  }
  if (typeof rawCell === "number" && Number.isSafeInteger(rawCell) && rawCell > 0) {
    return rawCell;
  }
  return null;
}

/**
 * Build a cycle-safe parent-child forest from `records` via `parentFieldId`.
 * Self-loops and multi-node cycles (e.g. A→B→A or A→B→C→A) are detected and
 * cleanly broken so malformed links can never cause infinite recursion.
 */
export function buildHierarchyTree(
  records: readonly BaseRecord[],
  parentFieldId: number | undefined,
  expansions?: Record<string, unknown>,
): HierarchyTreeResult {
  if (!parentFieldId) {
    return {
      roots: records.map((record) => ({
        record,
        depth: 0,
        parentId: null,
        children: [],
        descendantCount: 0,
      })),
      hadCycle: false,
      branchIds: [],
    };
  }

  const byId = new Map<number, BaseRecord>();
  for (const r of records) byId.set(r.id, r);

  const parentOf = new Map<number, number>();
  const cycleBroken = new Set<number>();
  let hadCycle = false;

  for (const r of records) {
    const pid = extractParentId(r, parentFieldId, expansions);
    if (pid === null || !byId.has(pid)) continue;
    if (pid === r.id) {
      hadCycle = true;
      cycleBroken.add(r.id);
      continue;
    }
    parentOf.set(r.id, pid);
  }

  // Detect and break cycles deterministically by walking upward from each node.
  // state: 0 = unvisited, 1 = on current path, 2 = verified acyclic
  const state = new Map<number, 0 | 1 | 2>();
  for (const r of records) {
    if (state.get(r.id) === 2) continue;
    const chain: number[] = [];
    let cur: number | undefined = r.id;
    while (cur !== undefined) {
      const st = state.get(cur) ?? 0;
      if (st === 2) break;
      if (st === 1) {
        // Cycle detected: break the incoming edge on the node closing the loop.
        const breaker = chain[chain.length - 1];
        if (breaker !== undefined) {
          parentOf.delete(breaker);
          cycleBroken.add(breaker);
          hadCycle = true;
        }
        break;
      }
      state.set(cur, 1);
      chain.push(cur);
      cur = parentOf.get(cur);
    }
    for (const id of chain) state.set(id, 2);
  }

  const childrenByParent = new Map<number, BaseRecord[]>();
  const rootRecords: BaseRecord[] = [];
  for (const r of records) {
    const pid = parentOf.get(r.id);
    if (pid === undefined) {
      rootRecords.push(r);
    } else {
      let arr = childrenByParent.get(pid);
      if (!arr) {
        arr = [];
        childrenByParent.set(pid, arr);
      }
      arr.push(r);
    }
  }

  const branchIds: number[] = [];
  const emitted = new Set<number>();

  const buildNode = (record: BaseRecord, depth: number, parentId: number | null): HierarchyNode => {
    emitted.add(record.id);
    const childRecs = childrenByParent.get(record.id) ?? [];
    const children: HierarchyNode[] = [];
    let descendantCount = 0;
    for (const childRec of childRecs) {
      if (emitted.has(childRec.id)) continue; // defensive secondary cycle guard
      const childNode = buildNode(childRec, depth + 1, record.id);
      children.push(childNode);
      descendantCount += 1 + childNode.descendantCount;
    }
    if (children.length > 0) branchIds.push(record.id);
    return {
      record,
      depth,
      parentId,
      children,
      descendantCount,
      ...(cycleBroken.has(record.id) ? { cycleBroken: true } : {}),
    };
  };

  const roots = rootRecords.map((r) => buildNode(r, 0, null));
  // Ensure any unreachable residue (should never happen after breaking cycles) is still shown.
  for (const r of records) {
    if (!emitted.has(r.id)) {
      roots.push(buildNode(r, 0, null));
    }
  }

  return { roots, hadCycle, branchIds };
}

/** Flatten visible tree nodes in DFS preorder, omitting children of collapsed nodes. */
export function flattenHierarchy(
  roots: readonly HierarchyNode[],
  collapsed: ReadonlySet<number>,
): HierarchyNode[] {
  const out: HierarchyNode[] = [];
  const visit = (nodes: readonly HierarchyNode[]) => {
    for (const node of nodes) {
      out.push(node);
      if (node.children.length > 0 && !collapsed.has(node.record.id)) {
        visit(node.children);
      }
    }
  };
  visit(roots);
  return out;
}

export interface HierarchyViewProps {
  baseId: number;
  tableId?: number;
  canEdit: boolean;
  fields: Field[];
  allFields?: Field[];
  records: BaseRecord[];
  expansions?: Record<string, unknown>;
  members: User[];
  parentFieldId?: number;
  onChangeParentField: (fieldId: number | undefined) => void;
  onMutate: () => void | Promise<unknown>;
  onOpen?: (record: BaseRecord) => void;
}

export function HierarchyView({
  baseId,
  tableId,
  canEdit,
  fields,
  allFields,
  records,
  expansions,
  members,
  parentFieldId,
  onChangeParentField,
  onMutate,
  onOpen,
}: HierarchyViewProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ rid: number; fid: number } | null>(null);
  const [busyParentField, setBusyParentField] = useState(false);
  const [addingFor, setAddingFor] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const schemaFields = allFields ?? fields;
  const selfLinkFields = useMemo(
    () => schemaFields.filter((f) => isSelfLinkField(f, baseId, tableId)),
    [schemaFields, baseId, tableId],
  );
  const effectiveParentFieldId = useMemo(() => {
    if (parentFieldId && selfLinkFields.some((f) => f.id === parentFieldId)) {
      return parentFieldId;
    }
    return selfLinkFields[0]?.id;
  }, [parentFieldId, selfLinkFields]);

  // Keep formula cache fresh for all records shown in hierarchy view.
  for (const r of records) {
    setFormulaCache(r, evalFormulas(schemaFields, r, members));
  }

  const tree = useMemo(
    () => buildHierarchyTree(records, effectiveParentFieldId, expansions),
    [records, effectiveParentFieldId, expansions],
  );
  const visibleNodes = useMemo(
    () => flattenHierarchy(tree.roots, collapsed),
    [tree.roots, collapsed],
  );

  const primaryField = recordTitleField(fields) ?? fields[0];
  const secondaryFields = useMemo(
    () => fields.filter((f) => f.id !== primaryField?.id),
    [fields, primaryField?.id],
  );

  const toggleNode = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(tree.branchIds));

  const createParentLinkField = async () => {
    if (!canEdit || busyParentField) return;
    setBusyParentField(true);
    setErrorMsg(null);
    try {
      const existingNames = new Set(schemaFields.map((f) => f.name));
      const baseName = t("父记录");
      let fieldName = baseName;
      let idx = 2;
      while (existingNames.has(fieldName)) {
        fieldName = `${baseName} ${idx++}`;
      }
      const created = await baseApi.addField(baseId, {
        name: fieldName,
        type: "link",
        options: [String(baseId)],
        tableId,
        targetTableId: tableId,
      });
      onChangeParentField(created.id);
      await onMutate();
    } catch {
      setErrorMsg(t("创建父任务关联字段失败，请检查权限后重试。"));
    } finally {
      setBusyParentField(false);
    }
  };

  const addChildRecord = async (parentRecordId: number | null) => {
    if (!canEdit || addingFor !== null) return;
    setAddingFor(parentRecordId ?? 0);
    setErrorMsg(null);
    try {
      const cells: Record<string, Cell> = {};
      if (parentRecordId !== null && effectiveParentFieldId) {
        cells[String(effectiveParentFieldId)] = [parentRecordId];
      }
      await baseApi.addRecord(baseId, cells, tableId);
      if (parentRecordId !== null) {
        setCollapsed((prev) => {
          if (!prev.has(parentRecordId)) return prev;
          const next = new Set(prev);
          next.delete(parentRecordId);
          return next;
        });
      }
      await onMutate();
    } catch {
      setErrorMsg(t("添加子记录失败，请稍后重试。"));
    } finally {
      setAddingFor(null);
    }
  };

  const commitCell = async (rec: BaseRecord, f: Field, v: Cell | null) => {
    setEditing(null);
    if (!canEdit || REGISTRY[f.type]?.readonly) return;
    const cur = rec.cells[f.id];
    if (cur === v || (cur === undefined && (v === null || v === ""))) return;
    setErrorMsg(null);
    try {
      await baseApi.setCells(baseId, rec.id, { [String(f.id)]: v === "" ? null : v });
      await onMutate();
    } catch {
      setErrorMsg(t("保存单元格失败，请重试。"));
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface" data-hierarchy-view>
      {/* Hierarchy control bar */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-[#f7f8fa]/70 px-4 py-2 text-[13px] dark:bg-sidebar/40" data-hierarchy-toolbar>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <GitBranch size={14} strokeWidth={1.7} className="shrink-0 text-[#0ea5a4]" aria-hidden />
          <span className="text-[12px]">{t("父子关联字段")}</span>
        </div>
        {selfLinkFields.length > 0 ? (
          <FeishuSelect
            value={effectiveParentFieldId ? String(effectiveParentFieldId) : ""}
            options={selfLinkFields.map((f) => ({ value: String(f.id), label: f.name }))}
            onChange={(val) => onChangeParentField(Number(val) || undefined)}
            ariaLabel={t("父子关联字段")}
            className="h-7 border border-[#dee0e3] bg-surface px-2 text-[12px] font-medium"
            chevronSize={12}
            menuMinWidth={140}
            dataAttr={{ "data-hierarchy-parent-select": true }}
          />
        ) : (
          <span className="text-[12px] text-subtle" data-hierarchy-no-parent-field>
            {t("暂无同表关联字段")}
          </span>
        )}
        {canEdit && selfLinkFields.length === 0 && (
          <button
            type="button"
            disabled={busyParentField}
            onClick={() => void createParentLinkField()}
            data-hierarchy-create-parent-field
            className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[12px] font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            <Plus size={13} strokeWidth={2} />
            {busyParentField ? t("创建中…") : t("创建父任务关联字段")}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          {tree.hadCycle && (
            <span
              className="mr-2 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700"
              data-hierarchy-cycle-warning
            >
              <AlertTriangle size={12} />
              {t("已自动断开循环关联")}
            </span>
          )}
          <button
            type="button"
            onClick={expandAll}
            disabled={tree.branchIds.length === 0}
            data-hierarchy-expand-all
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-40"
          >
            <ChevronsUpDown size={13} strokeWidth={1.7} />
            {t("全部展开")}
          </button>
          <button
            type="button"
            onClick={collapseAll}
            disabled={tree.branchIds.length === 0}
            data-hierarchy-collapse-all
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-40"
          >
            <ChevronsDownUp size={13} strokeWidth={1.7} />
            {t("全部折叠")}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div role="alert" className="border-b bg-rose-50 px-4 py-1.5 text-[12px] text-rose-700">
          {errorMsg}
        </div>
      )}

      {!effectiveParentFieldId && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-[#edf2ff]/60 px-4 py-2.5 text-[12px] text-[#245bdb] dark:bg-accent/50" data-hierarchy-setup-banner>
          <span>{t("配置一个指向当前表的「关联」字段作为父级指针，即可按树形层级管理父子任务。")}</span>
          {canEdit && (
            <button
              type="button"
              disabled={busyParentField}
              onClick={() => void createParentLinkField()}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[12px] font-medium text-white hover:bg-primary-hover disabled:opacity-50"
            >
              <Plus size={13} />
              {t("创建父任务关联字段")}
            </button>
          )}
        </div>
      )}

      {/* Hierarchy tree table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[680px] border-collapse text-[13px]" data-hierarchy-table>
          <thead>
            <tr className="h-9 border-b bg-surface text-left text-[12px] font-medium text-muted-foreground">
              {primaryField && (
                <th className="sticky top-0 z-20 min-w-[300px] border-b border-r bg-surface px-3 font-normal text-foreground">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground"><TypeGlyph t={primaryField.type} size={14} /></span>
                    <span className="truncate">{primaryField.name}</span>
                  </div>
                </th>
              )}
              {secondaryFields.map((f) => (
                <th
                  key={f.id}
                  style={{ minWidth: Math.max(120, Math.min(REGISTRY[f.type]?.width ?? 160, 220)) }}
                  className="sticky top-0 z-20 border-b border-r bg-surface px-2.5 font-normal text-foreground"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground"><TypeGlyph t={f.type} size={14} /></span>
                    <span className="truncate">{f.name}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleNodes.length === 0 ? (
              <tr>
                <td colSpan={Math.max(1, (primaryField ? 1 : 0) + secondaryFields.length)} className="px-6 py-12 text-center text-[13px] text-subtle">
                  {t("暂无记录")}
                </td>
              </tr>
            ) : (
              visibleNodes.map((node) => {
                const { record, depth, children } = node;
                const hasChildren = children.length > 0;
                const isCollapsed = collapsed.has(record.id);
                const primaryEditing = primaryField && editing?.rid === record.id && editing.fid === primaryField.id;
                const primaryRo = primaryField ? !!REGISTRY[primaryField.type]?.readonly : true;

                return (
                  <tr
                    key={record.id}
                    data-hierarchy-row={record.id}
                    data-hierarchy-depth={depth}
                    className="group/hrow h-9 border-b transition-colors hover:bg-hover/40"
                  >
                    {primaryField && (
                      <td
                        className={cn(
                          "relative border-r px-2.5",
                          primaryEditing && "z-10 outline outline-2 -outline-offset-2 outline-primary",
                        )}
                        onDoubleClick={() => {
                          if (canEdit && !primaryRo && primaryField.type !== "link") {
                            setEditing({ rid: record.id, fid: primaryField.id });
                          }
                        }}
                        data-hierarchy-cell={`${record.id}:${primaryField.id}`}
                      >
                        <div className="flex h-8 min-w-0 items-center gap-1">
                          {/* Tree indentation & vertical guide lines */}
                          {depth > 0 && (
                            <span className="flex h-full shrink-0 items-stretch" aria-hidden>
                              {Array.from({ length: depth }).map((_, lvl) => (
                                <span
                                  key={lvl}
                                  className="inline-block w-5 border-l border-[#dee0e3] dark:border-border"
                                />
                              ))}
                            </span>
                          )}
                          {/* Expand / collapse chevron */}
                          {hasChildren ? (
                            <button
                              type="button"
                              aria-label={isCollapsed ? t("展开子记录") : t("折叠子记录")}
                              aria-expanded={!isCollapsed}
                              data-hierarchy-toggle={record.id}
                              onClick={() => toggleNode(record.id)}
                              className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"
                            >
                              <ChevronRight
                                size={14}
                                strokeWidth={1.8}
                                className={cn("transition-transform", !isCollapsed && "rotate-90")}
                              />
                            </button>
                          ) : (
                            <span className="grid size-5 shrink-0 place-items-center text-subtle/50" aria-hidden>
                              <span className="size-1.5 rounded-full bg-current" />
                            </span>
                          )}

                          {/* Primary cell value / editor */}
                          <div className="min-w-0 flex-1 overflow-hidden">
                            {primaryEditing ? (
                              <CellEditor
                                field={primaryField}
                                record={record}
                                members={members}
                                onCommit={(v) => void commitCell(record, primaryField, v)}
                                onCancel={() => setEditing(null)}
                              />
                            ) : (
                              <div className="flex min-w-0 items-center gap-1.5">
                                <div className="min-w-0 flex-1 truncate font-medium text-foreground">
                                  <CellView
                                    field={primaryField}
                                    record={record}
                                    members={members}
                                    allFields={schemaFields}
                                    compact
                                    canEdit={canEdit && !primaryRo}
                                    onToggle={canEdit && !primaryRo ? (v) => void commitCell(record, primaryField, v) : undefined}
                                    onEdit={() => setEditing({ rid: record.id, fid: primaryField.id })}
                                  />
                                </div>
                                {hasChildren && (
                                  <span
                                    data-hierarchy-child-count={record.id}
                                    className="shrink-0 rounded-full bg-[#edf2ff] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-primary dark:bg-accent"
                                    title={t("包含 {n} 条子记录", { n: node.descendantCount })}
                                  >
                                    {children.length}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Row quick actions: open detail + add child record */}
                          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/hrow:opacity-100 focus-within:opacity-100">
                            {onOpen && (
                              <button
                                type="button"
                                onClick={() => onOpen(record)}
                                title={t("展开记录")}
                                aria-label={t("展开记录")}
                                data-hierarchy-open={record.id}
                                className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-primary"
                              >
                                <Expand size={13} strokeWidth={1.7} />
                              </button>
                            )}
                            {canEdit && effectiveParentFieldId && (
                              <button
                                type="button"
                                disabled={addingFor !== null}
                                onClick={() => void addChildRecord(record.id)}
                                data-hierarchy-add-child={record.id}
                                title={t("添加子记录")}
                                aria-label={t("添加子记录")}
                                className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] font-medium text-primary hover:bg-[#edf2ff] disabled:opacity-40 dark:hover:bg-accent"
                              >
                                <Plus size={12} strokeWidth={2} />
                                <span>{t("添加子记录")}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    )}
                    {secondaryFields.map((f) => {
                      const isEditing = editing?.rid === record.id && editing.fid === f.id;
                      const ro = !!REGISTRY[f.type]?.readonly;
                      return (
                        <td
                          key={f.id}
                          className={cn(
                            "relative border-r px-2.5",
                            (f.type === "number" || f.type === "currency") && "text-right tabular-nums",
                            isEditing && "z-10 outline outline-2 -outline-offset-2 outline-primary",
                          )}
                          onDoubleClick={() => {
                            if (canEdit && !ro && f.type !== "checkbox" && f.type !== "link") {
                              setEditing({ rid: record.id, fid: f.id });
                            }
                          }}
                          data-hierarchy-cell={`${record.id}:${f.id}`}
                        >
                          {isEditing ? (
                            <CellEditor
                              field={f}
                              record={record}
                              members={members}
                              onCommit={(v) => void commitCell(record, f, v)}
                              onCancel={() => setEditing(null)}
                            />
                          ) : (
                            <div className="flex h-8 min-w-0 items-center overflow-hidden">
                              <CellView
                                field={f}
                                record={record}
                                members={members}
                                allFields={schemaFields}
                                compact
                                canEdit={canEdit && !ro}
                                onToggle={canEdit && !ro ? (v) => void commitCell(record, f, v) : undefined}
                                onEdit={() => setEditing({ rid: record.id, fid: f.id })}
                              />
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
            {canEdit && (
              <tr className="h-9 border-b">
                <td colSpan={Math.max(1, (primaryField ? 1 : 0) + secondaryFields.length)} className="px-3">
                  <button
                    type="button"
                    disabled={addingFor !== null}
                    onClick={() => void addChildRecord(null)}
                    data-hierarchy-add-root
                    className="inline-flex h-7 items-center gap-1 rounded px-2 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-40"
                  >
                    <Plus size={14} strokeWidth={1.8} />
                    {t("新增顶级记录")}
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
