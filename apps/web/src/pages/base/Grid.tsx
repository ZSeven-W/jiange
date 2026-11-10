import { Fragment, useEffect, useRef, useState } from "react";
import { ApiError, baseApi, type BaseRecord, type Cell, type Field, type FillRule, type RowHeight, type User } from "@/lib/api";
import { rowFill, rowHeightPx } from "./fill";
import { ask } from "@/components/ui/ask";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CellEditor, CellView } from "./cells";
import { FieldForm, FieldMenu, type FieldMenuAction } from "./fields";
import { RecordDetail } from "./RecordDetail";
import { displayValue, evalFormulas, memberName, PALETTE, personIDs, REGISTRY, setFormulaCache, optionColor } from "./registry";
import { TypeGlyph } from "./cells";
import { planPaste, rangeText, skippedPasteMessage } from "./tsv";
import { ChevronRight, Expand, Lock, Pencil, Trash2, X } from "lucide-react";
import { CELL_UNKNOWN, cellDraft, isAuthoredCellType, refreshWrites, runWriteBatch, useWriteLedger, WriteNotAttempted } from "./writeSafety";
import { authorizedDetailRecord } from "./recordAuthorization";
import { captureGridSelection, validGridSelection, waitForBatchTargets, type GridSelection, type SelectionRect } from "./gridSelection";
import { mergeVisibleFieldOrder, planFieldReorder } from "./fieldReorder";

/** Column widths per field, persisted locally so they survive refresh. */
function loadWidths(baseId: number): Record<number, number> {
  try {
    return JSON.parse(localStorage.getItem(`jiange:fieldWidths:${baseId}`) ?? "{}");
  } catch {
    return {};
  }
}

interface Edit {
  rid: number;
  fid: number;
  draft: Cell | null;
  dirty: boolean;
  authorization: string | null;
  authored: boolean;
}

export function Grid({
  baseId,
  canEdit,
  fields,
  allFields,
  records,
  authorizedRecords,
  detailAccessReady = true,
  selectionAccessReady = true,
  preventCopy = false,
  members,
  groupBy,
  onMutate,
  onDetailVisibilityChange,
  onFieldAction,
  rowHeight,
  fills,
  frozen,
}: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  /** Full authorized order, including fields hidden only in the current view. */
  allFields?: Field[];
  records: BaseRecord[];
  /** Records from the current authorized Base snapshot, before local filters. */
  authorizedRecords?: BaseRecord[];
  /** Hide details during authorization revalidation. */
  detailAccessReady?: boolean;
  /** Query/filter results must also be current before resuming a batch. */
  selectionAccessReady?: boolean;
  preventCopy?: boolean;
  members: User[];
  /** grid grouping field id (from the view config), null = ungrouped */
  groupBy?: number | null;
  onMutate: () => void;
  onDetailVisibilityChange?: (visible: boolean) => void;
  /** Field header menu shortcuts that change the view config (sort/group/filter). */
  onFieldAction?: (action: FieldMenuAction, field: Field) => void;
  /** Feishu 行高 preset from the view config. */
  rowHeight?: RowHeight;
  /** Feishu 填色 rules from the view config. */
  fills?: FillRule[];
  /** Leading visible fields kept frozen (sticky) while scrolling; default 1. */
  frozen?: number;
}) {
  const { ledger } = useWriteLedger(baseId);
  const [edit, setEditState] = useState<Edit | null>(null);
  const editRef = useRef<Edit | null>(null);
  const setEdit = (next: Edit | null | ((current: Edit | null) => Edit | null)) => {
    const value = typeof next === "function" ? next(editRef.current) : next;
    editRef.current = value;
    setEditState(value);
  };
  const [newField, setNewField] = useState(false);
  /** 向左/右插入字段: the anchor header and the position for the new field. */
  const [insertAt, setInsertAt] = useState<{ fid: number; position: number } | null>(null);
  /** 勾选的记录（表头复选框 / 行复选框）。 */
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [editField, setEditField] = useState<Field | null>(null);
  const [widths, setWidths] = useState<Record<number, number>>(() => loadWidths(baseId));
  const [drag, setDrag] = useState<{ fid: number; at: number | null; order: number[]; allOrder: number[] }>({ fid: 0, at: null, order: [], allOrder: [] });
  const [dragError, setDragError] = useState<string | null>(null);
  const [sel, setSel] = useState<GridSelection | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const detail = authorizedDetailRecord(detailId, authorizedRecords ?? records, detailAccessReady);
  const detailIndex = detailId === null ? -1 : records.findIndex((r) => r.id === detailId);
  useEffect(() => {
    if (detailId === null || !detailAccessReady || detail) return;
    setDetailId(null);
    onDetailVisibilityChange?.(false);
  }, [detailId, detailAccessReady, detail, onDetailVisibilityChange]);
  useEffect(() => () => { onDetailVisibilityChange?.(false); }, [onDetailVisibilityChange]);
  const [stats, setStats] = useState<Record<number, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(`jiange:stats:${baseId}`) ?? "{}");
    } catch {
      return {};
    }
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    setChecked((prev) => {
      if (!prev.size) return prev;
      const live = new Set(records.map((r) => r.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [records]);
  const [vp, setVp] = useState({ top: 0, left: 0, h: 900, w: 1200 });
  const gridRef = useRef<HTMLDivElement>(null);
  const current = useRef({ baseId, canEdit, mounted: true, detailAccessReady, selectionAccessReady, authorizedRecords: authorizedRecords ?? records, fields, allFields });
  current.current = { baseId, canEdit, mounted: true, detailAccessReady, selectionAccessReady, authorizedRecords: authorizedRecords ?? records, fields, allFields };
  useEffect(() => { current.current.mounted = true; return () => { current.current.mounted = false; }; }, []);
  useEffect(() => () => {
    const draft = editRef.current;
    if (!draft?.dirty) return;
    const op = ledger.begin(t("记录 #{rid} · 字段 #{fid}", { rid: draft.rid, fid: draft.fid }), cellDraft(draft.draft), `cell:${draft.rid}:${draft.fid}`, draft.authorization, false, draft.authored);
    if (op !== null) ledger.fail(op, t("离开表格时输入尚未提交，请复制后核对。"));
    editRef.current = null;
  }, [ledger]);
  useEffect(() => {
    const active = editRef.current;
    if (!active) return;
    if (canEdit && records.some((record) => record.id === active.rid) && fields.some((field) => field.id === active.fid)) return;
    if (active.dirty) {
      const op = ledger.begin(t("记录 #{rid} · 字段 #{fid}", { rid: active.rid, fid: active.fid }), cellDraft(active.draft), `cell:${active.rid}:${active.fid}`, active.authorization, false, active.authored);
      if (op !== null) ledger.fail(op, t("记录、字段或编辑权限已变化；输入未提交，请复制后核对。"));
    }
    setEdit(null);
  }, [canEdit, records, fields, edit, ledger]);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp((v) => ({ ...v, h: el.clientHeight, w: el.clientWidth })));
    ro.observe(el);
    // drive virtualization from a rAF loop: scroll events alone are unreliable
    // (some webviews never fire them for programmatic scrolls)
    let raf = 0;
    const tick = () => {
      setVp((v) => (v.top === el.scrollTop && v.left === el.scrollLeft && v.h === el.clientHeight && v.w === el.clientWidth ? v : { top: el.scrollTop, left: el.scrollLeft, h: el.clientHeight, w: el.clientWidth }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  const width = (f: Field) => widths[f.id] ?? (f.isPrimary ? 280 : REGISTRY[f.type].width);
  const saveWidth = (fid: number, w: number) => {
    setWidths((prev) => {
      const next = { ...prev, [fid]: w };
      localStorage.setItem(`jiange:fieldWidths:${baseId}`, JSON.stringify(next));
      return next;
    });
  };

  // refresh the formula cache for the visible dataset (cheap: memoized per record)
  for (const rec of records) setFormulaCache(rec, evalFormulas(fields, rec, members));

  const rows = records.length;
  const cols = fields.length;
  // Never use a stale numeric offset after sort, filtering, insertion, deletion,
  // field reordering or a changed authorization projection.
  const selection = validGridSelection(sel, records, fields) ? sel : null;
  const readSelection = () => validGridSelection(sel, records, fields) ? sel : null;
  const setSelection = (rect: SelectionRect | null) => setSel(rect ? captureGridSelection(rect, records, fields) : null);
  useEffect(() => { setSel((current) => current && !validGridSelection(current, records, fields) ? null : current); }, [records, fields]);
  const inRange = (r: number, f: number) =>
    !!selection && r >= Math.min(selection.ar, selection.rr) && r <= Math.max(selection.ar, selection.rr) && f >= Math.min(selection.af, selection.rf) && f <= Math.max(selection.af, selection.rf);
  const isCursor = (r: number, f: number) => !!selection && selection.rr === r && selection.rf === f;

  const scrollCellIntoView = (r: number, f: number) => {
    const el = gridRef.current;
    if (!el) return;
    // with virtualization the cell may not be mounted: first bring the target
    // into the scroll window, then let scrollIntoView fine-tune
    const headerHeight = el.querySelector("thead")?.getBoundingClientRect().height ?? 36;
    const rowH = rowHeightPx(rowHeight);
    const targetTop = headerHeight + r * rowH;
    if (targetTop < el.scrollTop + headerHeight) el.scrollTop = Math.max(0, targetTop - headerHeight);
    else if (targetTop + rowH > el.scrollTop + el.clientHeight) el.scrollTop = targetTop + rowH - el.clientHeight;
    const rec = records[r];
    const fld = fields[f];
    if (!rec || !fld) return;
    el.querySelector(`[data-cell="${rec.id}:${fld.id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const move = (dr: number, df: number, extend = false) => {
    if (!rows || !cols) { setSelection(null); setEdit(null); return; }
    const base = readSelection() ?? { ar: 0, af: 0, rr: 0, rf: 0 };
    const rr = Math.min(rows - 1, Math.max(0, base.rr + dr));
    const rf = Math.min(cols - 1, Math.max(0, base.rf + df));
    setSelection(extend ? { ar: base.ar, af: base.af, rr, rf } : { ar: rr, af: rf, rr, rf });
    setEdit(null);
    scrollCellIntoView(rr, rf);
  };

  const setCell = async (rec: BaseRecord, f: Field, v: Cell | null, dir?: "down" | "right", raw?: string) => {
    const existing = editRef.current;
    const authorization = existing?.rid === rec.id && existing.fid === f.id ? existing.authorization : undefined;
    const authored = existing?.rid === rec.id && existing.fid === f.id ? existing.authored : raw !== undefined && isAuthoredCellType(f.type);
    setEdit(null);
    if (!current.current.mounted || current.current.baseId !== baseId || !current.current.canEdit) {
      const held = ledger.begin(t("记录 #{rid} · {field}", { rid: rec.id, field: f.name }), raw ?? cellDraft(v), `cell:${rec.id}:${f.id}`, authorization, false, authored);
      if (held !== null) ledger.fail(held, t("编辑权限或页面已变化；输入未提交，请复制后核对。"));
      return;
    }
    const cur = rec.cells[f.id];
    if (cur === v || (cur === undefined && (v === null || v === ""))) {
      if (dir === "down") move(1, 0);
      if (dir === "right") move(0, 1);
      return;
    }
    const draft = raw ?? cellDraft(v);
    const op = ledger.blocked("batch") ? null : ledger.begin(t("记录 #{rid} · {field}", { rid: rec.id, field: f.name }), draft, `cell:${rec.id}:${f.id}`, authorization, false, authored);
    if (op === null) { const held = ledger.begin(`记录 #${rec.id} · ${f.name}`, draft, `cell:${rec.id}:${f.id}`, authorization, true, authored); if (held !== null) ledger.fail(held, t("尚有未确认的修改，请先核对；本次输入未提交。")); return; }
    if (dir === "down") move(1, 0);
    if (dir === "right") move(0, 1);
    try {
      await baseApi.setCells(baseId, rec.id, { [f.id]: v === "" ? null : v });
      ledger.complete(op);
    } catch {
      ledger.fail(op, t(CELL_UNKNOWN));
    } finally { refreshWrites(onMutate); }
  };

  const startEdit = (ri: number, fi: number, seed?: string) => {
    if (!canEdit || !detailAccessReady || !selectionAccessReady) return;
    const f = fields[fi];
    const r = records[ri];
    if (!f || !r || !(authorizedRecords ?? records).some((record) => record.id === r.id) || ledger.blocked("batch") || ledger.blocked(`cell:${r.id}:${f.id}`) || REGISTRY[f.type].readonly || f.type === "checkbox" || f.type === "link" || f.type === "lookup") return;
    setSelection({ ar: ri, af: fi, rr: ri, rf: fi });
    const authored = isAuthoredCellType(f.type);
    setEdit({ rid: r.id, fid: f.id, draft: seed ?? displayValue(r, f, members) ?? null, dirty: seed !== undefined, authorization: ledger.capture(`cell:${r.id}:${f.id}`, authored), authored });
  };

  // Each batch is bound to IDs captured at initiation. A successful write can
  // trigger WS/HTTP revalidation; wait for that fresh authorization rather than
  // aborting normal multi-row pastes, then check every original target again.
  const awaitBatchAuthorization = async (recordIds: number[], fieldIds: number[]) => {
    if (!await waitForBatchTargets(() => current.current, baseId, recordIds, fieldIds)) throw new WriteNotAttempted();
  };

  const clearRange = async () => {
    const active = readSelection();
    if (!canEdit || !active) return;
    const r0 = Math.min(active.ar, active.rr);
    const r1 = Math.max(active.ar, active.rr);
    const f0 = Math.min(active.af, active.rf);
    const f1 = Math.max(active.af, active.rf);
    const selected = records.slice(r0, r1 + 1);
    if (!selected.length || !fields[f0] || !fields[f1] || ledger.hasCellWrites()) return;
    const original = rangeText(records, fields, members, r0, r1, f0, f1);
    const op = ledger.begin(t("清空单元格"), original, "batch");
    if (op === null) return;
    try {
      const targetFields = fields.slice(f0, f1 + 1).map((field) => field.id);
      const targetRecords = selected.map((record) => record.id);
      const result = await runWriteBatch(selected.map((rec) => async () => {
        await awaitBatchAuthorization(targetRecords, targetFields);
        const cells: Record<string, Cell | null> = {};
        for (let f = f0; f <= f1; f++) cells[fields[f].id] = null;
        return baseApi.setCells(baseId, rec.id, cells);
      }));
      if (result.complete) ledger.complete(op);
      else ledger.fail(op, result.attempted === result.confirmed
        ? t("已确认清空 {n} 行；数据或权限已变化，后续 {rest} 行未尝试。请核对后再操作。", { n: result.confirmed, rest: result.total - result.attempted })
        : t("已确认清空 {n} 行；当前行结果未知，后续 {rest} 行未尝试。请核对后再操作。", { n: result.confirmed, rest: result.total - result.attempted }));
    } catch {
      ledger.fail(op, t("清空结果无法确认，请核对后再操作。"));
    } finally { refreshWrites(onMutate); }
  };

  const copy = async () => {
    const active = readSelection();
    if (preventCopy || !active) return;
    const text = rangeText(records, fields, members, active.ar, active.rr, active.af, active.rf);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* headless or denied: selection still works, paste via the event below */
    }
  };

  const paste = async (text: string) => {
    if (!canEdit) return;
    const active = readSelection();
    if (!active) { const held = ledger.begin(t("粘贴"), text); if (held !== null) ledger.fail(held, t("选区已变化或尚未选择，本次粘贴未提交；请重新选择单元格。")); return; }
    const plan = planPaste(records, fields, Math.min(active.ar, active.rr), Math.min(active.af, active.rf), text, members);
    const scope = { kind: "paste" as const, ...plan.scope };
    const total = plan.patches.length + plan.addRows.length;
    if (!total) { const held = ledger.begin(t("粘贴"), text, undefined, undefined, false, true, scope); if (held !== null) ledger.fail(held, `${plan.skipped.length ? skippedPasteMessage(plan.skipped, t) : t("没有可粘贴的内容。")}${t("本次粘贴未提交。")}`, plan.skipped.length ? skippedPasteMessage(plan.skipped, t) : undefined); return; }
    const op = ledger.hasCellWrites() ? null : ledger.begin(t("粘贴"), text, "batch", undefined, false, true, scope);
    if (op === null) { const held = ledger.begin(t("粘贴"), text, undefined, undefined, false, true, scope); if (held !== null) ledger.fail(held, t("尚有未确认的修改，请先核对；本次粘贴未提交。")); return; }
    try {
      const ensureCurrent = () => awaitBatchAuthorization(plan.scope.recordIds, plan.scope.fieldIds);
      const existing = plan.patches.map((patch) => async () => { await ensureCurrent(); return baseApi.setCells(baseId, patch.rid, patch.cells); });
      const additions = plan.addRows.map((row) => async () => {
        await ensureCurrent();
        const cells: Record<string, Cell> = {};
        for (const [k, v] of Object.entries(row.cells)) if (v !== null) cells[k] = v;
        return baseApi.addRecord(baseId, cells);
      });
      const result = await runWriteBatch([...existing, ...additions]);
      if (result.complete && !plan.skipped.length) ledger.complete(op);
      else if (result.complete) ledger.fail(op, `${t("已确认处理 {n} 行。", { n: result.confirmed })}${skippedPasteMessage(plan.skipped, t)}${t("原始内容已保留，请核对后再操作，勿直接重复粘贴。")}`, skippedPasteMessage(plan.skipped, t));
      else ledger.fail(op, `${result.attempted === result.confirmed ? t("已确认处理 {n} 行；数据或权限已变化，后续 {rest} 行未尝试。", { n: result.confirmed, rest: result.total - result.attempted }) : t("已确认处理 {n} 行；当前行结果未知，后续 {rest} 行未尝试。", { n: result.confirmed, rest: result.total - result.attempted })}${plan.skipped.length ? skippedPasteMessage(plan.skipped, t) : ""}${t("新增行可能已创建，请核对后再操作，勿直接重复粘贴。")}`, plan.skipped.length ? skippedPasteMessage(plan.skipped, t) : t("粘贴结果未全部确认，请先核对。"));
    } catch {
      ledger.fail(op, t("粘贴结果无法确认，请核对记录后再操作，勿直接重复粘贴。"));
    } finally { refreshWrites(onMutate); }
  };

  const addRecord = async () => {
    const op = ledger.begin(t("新增记录"), "", "record:create");
    if (op === null) return;
    try { await baseApi.addRecord(baseId); ledger.complete(op); }
    catch { ledger.fail(op, t("无法确认是否创建。请刷新并核对记录，勿直接重复新增。")); }
    finally { refreshWrites(onMutate); }
  };

  const deleteRecord = async (rec: BaseRecord) => {
    const op = ledger.begin(t("删除记录 #{id}", { id: rec.id }), "", `record:delete:${rec.id}`);
    if (op === null) return;
    try { await baseApi.deleteRecord(baseId, rec.id); ledger.complete(op); }
    catch { ledger.fail(op, t("无法确认是否删除。请刷新并核对记录。")); }
    finally { refreshWrites(onMutate); }
  };

  const deleteChecked = async () => {
    const targets = records.filter((r) => checked.has(r.id));
    if (!targets.length || !(await ask(t("删除选中的 {n} 条记录？", { n: targets.length }), t("删除后无法直接撤销。")))) return;
    for (const rec of targets) await deleteRecord(rec);
    setChecked(new Set());
  };

  /** Position between f and its neighbour in the full field order (left or right). */
  const insertPosition = (f: Field, side: "left" | "right") => {
    const order = [...(allFields ?? fields)].sort((a, b) => a.position - b.position);
    const i = order.findIndex((x) => x.id === f.id);
    const other = side === "left" ? order[i - 1] : order[i + 1];
    if (!other) return side === "left" ? f.position - 1 : f.position + 1;
    return (f.position + other.position) / 2;
  };

  const deleteField = async (f: Field) => {
    if (!current.current.mounted || current.current.baseId !== baseId || !current.current.canEdit) return;
    const op = ledger.begin(t("删除字段「{name}」", { name: f.name }), "", `field:delete:${f.id}`);
    if (op === null) return;
    try { await baseApi.deleteField(baseId, f.id); ledger.complete(op); }
    catch { ledger.fail(op, t("无法确认字段是否删除。请刷新并核对字段列表。")); }
    finally { refreshWrites(onMutate); }
  };

  const saveField = async (patch: Partial<Field>, fid?: number) => {
    if (!current.current.mounted || current.current.baseId !== baseId || !current.current.canEdit) throw new Error("editing unavailable");
    const label = fid === undefined ? t("新增字段") : t("修改字段 #{id}", { id: fid });
    const op = ledger.begin(label, cellDraft(patch), fid === undefined ? "field:create" : `field:edit:${fid}`);
    if (op === null) throw new Error("previous result unresolved");
    try {
      if (fid === undefined) await baseApi.addField(baseId, patch);
      else await baseApi.patchField(baseId, fid, patch);
      ledger.complete(op);
    } catch (error) {
      ledger.fail(op, t("无法确认字段是否已保存。请刷新并核对字段列表，勿直接重复提交。"));
      throw error;
    } finally { refreshWrites(onMutate); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (edit) return; // the cell editor handles its own keys
    const mod = e.metaKey || e.ctrlKey;
    const selection = readSelection();
    if (mod && e.key.toLowerCase() === "c") {
      if (preventCopy || sel) e.preventDefault();
      if (!preventCopy && selection) void copy();
      return;
    }
    if (!selection && !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Tab", "Enter"].includes(e.key)) return;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        return move(-1, 0, e.shiftKey);
      case "ArrowDown":
        e.preventDefault();
        return move(1, 0, e.shiftKey);
      case "ArrowLeft":
        e.preventDefault();
        return move(0, -1, e.shiftKey);
      case "ArrowRight":
        e.preventDefault();
        return move(0, 1, e.shiftKey);
      case "Home":
        e.preventDefault();
        return selection && setSelection({ ...selection, rf: 0, af: e.shiftKey ? selection.af : 0 });
      case "End":
        e.preventDefault();
        return selection && setSelection({ ...selection, rf: cols - 1, af: e.shiftKey ? selection.af : cols - 1 });
      case "Tab":
        e.preventDefault();
        return e.shiftKey ? tab(-1) : tab(1);
      case "Enter":
        e.preventDefault();
        if (!selection) return setSelection({ ar: 0, af: 0, rr: 0, rf: 0 });
        return fields[selection.rf]?.type === "checkbox" ? toggleAt(selection.rr, selection.rf) : startEdit(selection.rr, selection.rf);
      case "F2":
        e.preventDefault();
        if (selection) startEdit(selection.rr, selection.rf);
        return;
      case " ":
        e.preventDefault();
        if (selection && fields[selection.rf]?.type === "checkbox") toggleAt(selection.rr, selection.rf);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        return void clearRange();
      case "Escape":
        return selection && setSelection({ ar: selection.rr, af: selection.rf, rr: selection.rr, rf: selection.rf });
    }
    if (!mod && !e.altKey && canEdit && e.key.length === 1 && selection) {
      e.preventDefault();
      startEdit(selection.rr, selection.rf, e.key);
    }
  };

  const tab = (dir: 1 | -1) => {
    if (!rows || !cols) return;
    const base = readSelection() ?? { rr: 0, rf: 0 };
    let rr = base.rr, rf = base.rf;
    if (dir === 1 && rf === cols - 1 && rr < rows - 1) { rr++; rf = 0; }
    else if (dir === -1 && rf === 0 && rr > 0) { rr--; rf = cols - 1; }
    else rf = Math.min(cols - 1, Math.max(0, rf + dir));
    setSelection({ ar: rr, af: rf, rr, rf });
    setEdit(null);
    scrollCellIntoView(rr, rf);
  };

  const toggleAt = (ri: number, fi: number) => {
    const rec = records[ri];
    const f = fields[fi];
    if (!rec || !f || !canEdit) return;
    void setCell(rec, f, rec.cells[f.id] === true ? null : true);
  };

  // The drop slot is measured before removing the dragged field.
  const reorder = async (fid: number, index: number, order: number[], allOrder: number[]) => {
    setDragError(null);
    if (!current.current.mounted || !current.current.canEdit || !current.current.detailAccessReady || !current.current.selectionAccessReady) { setDragError(t("正在确认权限，请稍后重新拖动字段。")); return; }
    const full = current.current.allFields;
    if (!full || full.length !== allOrder.length || !allOrder.every((id, i) => full[i]?.id === id)) { setDragError(t("字段顺序已变化，请刷新后重新拖动。")); return; }
    const plan = planFieldReorder(current.current.fields, fid, index, order);
    if (plan.kind === "noop") return;
    if (plan.kind !== "move") { setDragError(t("字段顺序已变化或无法安全调整，请刷新后重新拖动。")); return; }
    const desired = mergeVisibleFieldOrder(allOrder, order, plan.desiredIds);
    if (!desired) { setDragError(t("无法确认完整字段顺序，请刷新后重新拖动。")); return; }
    const op = ledger.begin(t("调整字段顺序"), "", `field:order:${fid}`);
    if (op === null) return;
    try { await baseApi.reorderFields(baseId, allOrder, desired); ledger.complete(op); }
    catch (error) {
      if (error instanceof ApiError && error.status === 409) { ledger.complete(op); setDragError(t("字段顺序已变化，未执行拖动，请刷新后重试。")); }
      else ledger.fail(op, t("无法确认顺序是否已保存，请刷新并核对。"));
    }
    finally { refreshWrites(onMutate); }
  };

  const startResize = (e: React.MouseEvent, f: Field) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width(f);
    const move2 = (ev: MouseEvent) => saveWidth(f.id, Math.min(600, Math.max(80, Math.round(startW + ev.clientX - startX))));
    const up = () => {
      window.removeEventListener("mousemove", move2);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move2);
    window.addEventListener("mouseup", up);
  };

  const dropOn = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    const fid = Number(e.dataTransfer.getData("text/field")) || drag.fid;
    if (canEdit && fid && fid === drag.fid) void reorder(fid, index, drag.order, drag.allOrder);
    setDrag({ fid: 0, at: null, order: [], allOrder: [] });
  };

  // --- column statistics (sum/avg/count/empty), chosen per column ---
  const saveStat = (fid: number, fn: string) => {
    setStats((prev) => {
      const next = { ...prev };
      if (fn) next[fid] = fn;
      else delete next[fid];
      localStorage.setItem(`jiange:stats:${baseId}`, JSON.stringify(next));
      return next;
    });
  };
  const statValue = (f: Field, fn: string, rows: BaseRecord[]): string => {
    const vals = rows.map((r) => displayValue(r, f, members));
    const present = vals.filter((v) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0));
    const empty = rows.length - present.length;
    switch (fn) {
      case "sum":
        return `${present.reduce((a: number, v) => a + Number(v ?? 0), 0)}`;
      case "avg":
        return `${present.length ? (present.reduce((a: number, v) => a + Number(v ?? 0), 0) / present.length).toFixed(2) : "—"}`;
      case "count":
        return `${present.length}`;
      case "empty":
        return `${empty}`;
      default:
        return "";
    }
  };
  const statFns = (f: Field) => (f.type === "number" ? ["sum", "avg", "count", "empty"] : ["count", "empty"]);

  // --- grid grouping (any field) ---
  const groupField = fields.find((f) => f.id === groupBy);
  const groups: { key: string; rows: BaseRecord[] }[] = [];
  if (groupField) {
    const index = new Map<string, { key: string; rows: BaseRecord[] }>();
    const push = (key: string, r: BaseRecord) => {
      let g = index.get(key);
      if (!g) {
        g = { key, rows: [] };
        index.set(key, g);
        groups.push(g);
      }
      g.rows.push(r);
    };
    for (const r of records) {
      const raw = displayValue(r, groupField, members);
      if (groupField.type === "person") {
        // 飞书式：一条记录出现在它每个成员的分组里，空值进未分组。
        const ids = personIDs(raw);
        if (!ids.length) push("", r);
        else ids.forEach((id) => push(String(id), r));
        continue;
      }
      const key = raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0) ? "" : String(raw);
      push(key, r);
    }
  }
  const groupColor = (key: string) => (groupField && groupField.type === "select" && key ? optionColor(groupField, key) : null);
  // 人员分组头显示成员名（key 是成员 id 字符串）。
  const groupLabel = (key: string) => (groupField?.type === "person" && key ? memberName(Number(key), members) || t("成员 #{id}", { id: key }) : key);
  const idxOf = new Map(records.map((r, i) => [r.id, i]));

  // --- virtualization: render only the visible window (plus overscan) ---
  const ROW_H = rowHeightPx(rowHeight);
  const tall = ROW_H > 32;
  const OVERSCAN = 6;
  const r0 = Math.max(0, Math.floor(vp.top / ROW_H) - OVERSCAN);
  const r1 = Math.min(rows, Math.ceil((vp.top + vp.h) / ROW_H) + OVERSCAN);
  const colOffsets = fields.reduce<number[]>((acc, f, i) => [...acc, (acc[i - 1] ?? 0) + width(f)], []);
  const totalW = colOffsets[cols - 1] ?? 0;
  // 冻结列: the first N visible fields stay rendered and sticky; only the rest is windowed.
  const nFrozen = Math.max(0, Math.min(cols, frozen ?? 1));
  const frozenW = nFrozen > 0 ? colOffsets[nFrozen - 1] : 0;
  let c0 = nFrozen;
  while (c0 < cols && colOffsets[c0] < vp.left + frozenW - 200) c0++;
  c0 = Math.max(nFrozen, c0 - 2);
  let c1 = c0;
  while (c1 < cols && colOffsets[c1] < vp.left + vp.w + 200) c1++;
  c1 = Math.min(cols, c1 + 2);
  const leadW = (c0 > 0 ? colOffsets[c0 - 1] : 0) - frozenW;
  const tailW = c1 < cols ? totalW - (colOffsets[c1 - 1] ?? 0) : 0;
  const winFields = [...fields.slice(0, nFrozen), ...fields.slice(c0, c1)];
  /** column index in `fields` for the wi-th rendered field */
  const wjSpacer = (w: number, rendered: number) => w > 0 && rendered <= nFrozen;
  const colOf = (wi: number) => (wi < nFrozen ? wi : c0 + wi - nFrozen);
  const stickyLeft = (j: number) => 56 + (j > 0 ? colOffsets[j - 1] : 0);
  const isFrozen = (j: number) => j < nFrozen;
  const lastFrozen = (j: number) => j === nFrozen - 1;
  const allChecked = records.length > 0 && records.every((r) => checked.has(r.id));
  const toggleChecked = (id: number) => setChecked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const renderRow = (rec: BaseRecord, i: number) => {
            const fill = rowFill(rec, allFields ?? fields, fills, members);
            const isChecked = checked.has(rec.id);
            return (
            <tr key={rec.id} className={cn("group", !tall && "h-8")} style={tall ? { height: ROW_H } : undefined} data-row-fill={fill}>
              <td className={cn("sticky left-0 z-10 w-14 border border-x-0 bg-surface px-1.5 text-[12px] text-subtle [@media(hover:none)]:px-1", tall && "align-top")} style={fill ? { background: fill } : undefined}>
                <div className="flex h-[31px] items-center justify-center gap-1">
                <span className={cn("group-hover:hidden [@media(hover:none)]:inline", isChecked && "hidden")}>{i + 1}</span>
                <input type="checkbox" checked={isChecked} onChange={() => toggleChecked(rec.id)} aria-label={t("选择记录 {n}", { n: i + 1 })} className={cn("size-3.5 cursor-pointer accent-primary group-hover:inline-block", isChecked ? "inline-block" : "hidden")} data-row-check={rec.id} />
                <span className={cn("hidden items-center justify-center gap-0.5 group-hover:flex [@media(hover:none)]:flex")}>
                  <button type="button" className="grid size-6 touch-manipulation place-items-center rounded text-subtle hover:text-primary [@media(hover:none)]:size-8" aria-label={t("展开记录 {n}", { n: i + 1 })} title={t("展开记录")} onClick={() => { setDetailId(rec.id); onDetailVisibilityChange?.(true); }} data-expand={rec.id}>
                    <Expand size={14} strokeWidth={1.7} />
                  </button>
                  {canEdit && (
                    <button type="button" className="text-subtle hover:text-destructive [@media(hover:none)]:hidden" title={t("删除记录")} onClick={() => void deleteRecord(rec)}>
                      ✕
                    </button>
                  )}
                </span>
                </div>
              </td>
              {winFields.map((f, wj) => {
                const j = colOf(wj);
                const editing = edit?.rid === rec.id && edit.fid === f.id;
                const ro = REGISTRY[f.type].readonly;
                const selected = !editing && inRange(i, j);
                return (
                  <Fragment key={f.id}>
                  {wj === nFrozen && leadW > 0 && <td style={{ width: leadW }} className="border p-0" aria-hidden />}
                  <td
                    style={{ ...(isFrozen(j) ? { position: "sticky", left: stickyLeft(j) } : {}), ...(fill && !selected && !editing ? { background: fill } : {}) }}
                    className={cn(
                      "relative border px-2.5",
                      tall && "align-top",
                      isFrozen(j) && "z-10 bg-surface",
                      j === 0 && "border-l-0",
                      lastFrozen(j) && "border-r-[#BBBFC4]",
                      f.type === "number" && "text-right tabular-nums",
                      editing && "relative z-20 outline outline-2 -outline-offset-2 outline-primary",
                      !editing && inRange(i, j) && (isCursor(i, j) ? "bg-sel-cursor" : "bg-sel-row"),
                    )}
                    onClick={(e) => {
                      if (editing) return;
                      setEdit(null);
                      const active = readSelection();
                      setSelection(e.shiftKey && active ? { ar: active.ar, af: active.af, rr: i, rf: j } : { ar: i, af: j, rr: i, rf: j });
                      gridRef.current?.focus();
                    }}
                    onDoubleClick={() => startEdit(i, j)}
                    data-cell={`${rec.id}:${f.id}`}
                  >
                    {editing ? (
                      <CellEditor
                        field={f}
                        record={rec}
                        members={members}
                        draft={editRef.current?.draft}
                        onDraft={(draft) => { const previous = editRef.current; if (previous?.rid === rec.id && previous.fid === f.id) editRef.current = { ...previous, draft, dirty: true }; }}
                        onCommit={(v, dir, raw) => void setCell(rec, f, v, dir, raw)}
                        onCancel={() => setEdit(null)}
                        onInvalid={(raw) => { const op = ledger.begin(`记录 #${rec.id} · ${f.name}`, raw, `cell:${rec.id}:${f.id}`, editRef.current?.authorization, false, editRef.current?.authored ?? false); if (op !== null) ledger.fail(op, t("输入格式无效，未保存；请复制后修改。")); }}
                      />
                    ) : <div className={cn("flex min-w-0 overflow-hidden", tall ? "items-start pt-[5px] [&_*]:whitespace-normal" : "h-[31px] items-center")} style={tall ? { height: ROW_H - 1 } : undefined} data-grid-cell-content>
                      <CellView
                        field={f}
                        record={rec}
                        members={members}
                        compact
                        canEdit={canEdit && !ro}
                        onToggle={canEdit && !ro ? () => toggleAt(i, j) : undefined}
                        onEdit={() => startEdit(i, j)}
                      />
                      {canEdit && detailAccessReady && selectionAccessReady && isCursor(i, j) && !ro && f.type !== "checkbox" && f.type !== "link" && f.type !== "lookup" && !ledger.blocked("batch") && !ledger.blocked(`cell:${rec.id}:${f.id}`) && <button type="button" data-touch-edit className="absolute right-0 top-0 hidden size-8 touch-manipulation items-center justify-center rounded bg-surface text-primary shadow-sm [@media(hover:none)]:inline-flex" aria-label={t("编辑记录 {n} 的{name}", { n: i + 1, name: f.name })} onClick={(event) => { event.stopPropagation(); startEdit(i, j); }}><Pencil size={14} strokeWidth={1.7} /></button>}
                    </div>}
                  </td>
                  </Fragment>
                );
              })}
              {wjSpacer(leadW, winFields.length) && <td style={{ width: leadW }} className="border p-0" aria-hidden />}
              {tailW > 0 && <td style={{ width: tailW }} className="border p-0" aria-hidden />}
              {canEdit && <td className="border" style={fill ? { background: fill } : undefined} />}
            </tr>
              );
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {dragError && <p role="alert" className="border-b px-3 py-2 text-[12px] text-destructive">{dragError}</p>}
    {checked.size > 0 && (
      <div className="flex h-10 shrink-0 items-center gap-3 border-b bg-[#f0f4ff] px-4 text-[13px]" role="toolbar" aria-label={t("批量操作")} data-batch-bar>
        <span>{t("已选择")} <b className="font-medium text-primary">{checked.size}</b> {t("条记录")}</span>
        {canEdit && <button type="button" className="flex h-7 items-center gap-1 rounded-md px-2 text-destructive hover:bg-white" onClick={() => void deleteChecked()} data-batch-delete><Trash2 size={14} strokeWidth={1.7} />{t("删除")}</button>}
        <button type="button" className="ml-auto grid size-7 place-items-center rounded-md text-subtle hover:bg-white" aria-label={t("取消选择")} onClick={() => setChecked(new Set())}><X size={15} /></button>
      </div>
    )}
    <div
      ref={gridRef}
      className="min-h-0 flex-1 overflow-auto outline-none"
      data-grid-scroll
      tabIndex={0}
      onKeyDown={onKey}
      onCopyCapture={(event) => { if (preventCopy) event.preventDefault(); }}
      onCutCapture={(event) => { if (preventCopy) event.preventDefault(); }}
      onPaste={(e) => {
        if (edit) return;
        const text = e.clipboardData.getData("text/plain");
        if (text) {
          e.preventDefault();
          void paste(text);
        }
      }}
    >
      {detailId !== null && !detailAccessReady && <aside className="fixed inset-y-0 right-0 z-40 grid w-full max-w-[420px] place-items-center border-l bg-surface text-[13px] text-subtle shadow-xl" role="status">{t("正在确认记录访问权限…")}</aside>}
      {detail && (
        <RecordDetail
          baseId={baseId}
          canEdit={canEdit}
          preventCopy={preventCopy}
          fields={fields}
          record={detail}
          members={members}
          onClose={() => { setDetailId(null); onDetailVisibilityChange?.(false); }}
          onMutate={onMutate}
          position={detailIndex >= 0 ? { index: detailIndex + 1, total: records.length } : undefined}
          onPrev={detailIndex > 0 ? () => setDetailId(records[detailIndex - 1].id) : undefined}
          onNext={detailIndex >= 0 && detailIndex < records.length - 1 ? () => setDetailId(records[detailIndex + 1].id) : undefined}
        />
      )}
      <table
        className="border-collapse table-fixed text-[14px]"
        data-grid
        style={{ width: 56 + totalW + (canEdit ? 44 : 0) }}
      >
        <thead>
          <tr className="h-9 bg-surface text-left text-[13px] text-foreground">
            <th className="sticky left-0 top-0 z-40 w-14 border border-x-0 bg-surface px-1.5 font-normal">
              <div className="flex items-center justify-center">
                <input type="checkbox" checked={allChecked} ref={(el) => { if (el) el.indeterminate = !allChecked && checked.size > 0; }} onChange={() => setChecked(allChecked ? new Set() : new Set(records.map((r) => r.id)))} aria-label={t("全选记录")} className="size-3.5 cursor-pointer accent-primary" data-check-all />
              </div>
            </th>
            {winFields.map((f, wi) => {
              const i = colOf(wi);
              return (
              <Fragment key={f.id}>
              {wi === nFrozen && leadW > 0 && <th style={{ width: leadW }} className="border p-0" aria-hidden />}
              <th
                className={cn("group/th sticky top-0 z-30 border bg-surface px-2.5 font-normal", isFrozen(i) && "z-40", i === 0 && "border-l-0", lastFrozen(i) && "border-r-[#BBBFC4]", drag.at === i && drag.fid && drag.fid !== f.id && "border-l-2 border-l-primary")}
                style={{ width: width(f), minWidth: width(f), ...(isFrozen(i) ? { left: stickyLeft(i) } : {}) }}
                draggable={canEdit && !!allFields && !f.isPrimary}
                data-th={f.id}
                onContextMenu={(e) => {
                  const trigger = e.currentTarget.querySelector<HTMLButtonElement>("[data-field-menu]");
                  if (!trigger) return;
                  e.preventDefault();
                  trigger.click();
                }}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/field", String(f.id));
                  e.dataTransfer.effectAllowed = "move";
                  if (!canEdit || !allFields || f.isPrimary) { e.preventDefault(); return; }
                  setDrag({ fid: f.id, at: null, order: fields.map((field) => field.id), allOrder: allFields.map((field) => field.id) });
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  const before = e.clientX < e.currentTarget.getBoundingClientRect().left + e.currentTarget.offsetWidth / 2;
                  const at = before ? i : i + 1;
                  if (drag.at !== at) setDrag((d) => ({ ...d, at }));
                }}
                onDrop={(e) => {
                  const before = e.clientX < e.currentTarget.getBoundingClientRect().left + e.currentTarget.offsetWidth / 2;
                  dropOn(e, before ? i : i + 1);
                }}
                onDragEnd={() => setDrag({ fid: 0, at: null, order: [], allOrder: [] })}
              >
                  <div className="flex items-center gap-1">
                    {!f.isPrimary && <span className="mr-0.5 hidden cursor-grab text-subtle group-hover/th:inline" title={t("拖拽排序")} data-drag-handle>
                      ⠿
                    </span>}
                    {f.isPrimary && <Lock size={13} className="shrink-0 text-subtle" aria-label={t("主字段")} />}
                    <span className="mr-1 text-muted-foreground"><TypeGlyph t={f.type} size={14} /></span>
                    <span className="truncate">{f.name}</span>
                    {canEdit && (
                      <span className="ml-auto">
                        <FieldMenu field={f} frozen={isFrozen(i) && lastFrozen(i)} onEdit={() => setEditField(f)} onDelete={() => void deleteField(f)} onDuplicate={() => void saveField({ name: t("{name} 副本", { name: f.name }), type: f.type, options: f.options, optionColors: f.optionColors, formula: f.formula, description: f.description, defaultValue: f.defaultValue ?? null, position: insertPosition(f, "right") }).catch(() => undefined)} onAction={(action) => {
                          if (action === "insert-left" || action === "insert-right") setInsertAt({ fid: f.id, position: insertPosition(f, action === "insert-left" ? "left" : "right") });
                          else onFieldAction?.(action, f);
                        }} />
                      </span>
                    )}
                  </div>
                {editField?.id === f.id && <FieldForm members={members} initial={f} onCancel={() => setEditField(null)} onSubmit={(patch) => saveField(patch, f.id)} onAcknowledge={() => ledger.discardKey(`field:edit:${f.id}`)} />}
                {insertAt?.fid === f.id && <FieldForm members={members} onCancel={() => setInsertAt(null)} onSubmit={(patch) => saveField({ ...patch, position: insertAt.position }).then(() => setInsertAt(null))} onAcknowledge={() => ledger.discardKey("field:create")} />}
                {canEdit && <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40" onMouseDown={(e) => startResize(e, f)} data-resize={f.id} />}
              </th>
              </Fragment>
              );
            })}
            {wjSpacer(leadW, winFields.length) && <th style={{ width: leadW }} className="border p-0" aria-hidden />}
            {tailW > 0 && <th style={{ width: tailW }} className="border p-0" aria-hidden />}
            {canEdit && (
              <th
                className="sticky top-0 z-30 relative w-11 border bg-surface text-center font-normal"
                onDragOver={(e) => {
                  e.preventDefault();
                  if (drag.at !== fields.length) setDrag((d) => ({ ...d, at: fields.length }));
                }}
                onDrop={(e) => dropOn(e, fields.length)}
              >
                <button className="size-full text-[16px] text-subtle hover:text-foreground" onClick={() => setNewField((v) => !v)} aria-label={t("添加字段")} disabled={ledger.blocked("field:create")}>
                  +
                </button>
                {newField && <FieldForm members={members} onCancel={() => setNewField(false)} onSubmit={(f) => saveField(f)} onAcknowledge={() => ledger.discardKey("field:create")} />}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {!groupField && r0 > 0 && (
            <tr aria-hidden style={{ height: r0 * ROW_H }}>
              <td colSpan={winFields.length + 3} className="border-0 p-0" />
            </tr>
          )}
          {!groupField && records.slice(r0, r1).map((rec, ri) => renderRow(rec, r0 + ri))}
          {!groupField && r1 < rows && (
            <tr aria-hidden style={{ height: (rows - r1) * ROW_H }}>
              <td colSpan={winFields.length + 3} className="border-0 p-0" />
            </tr>
          )}
          {groupField &&
            groups.map((g) => {
              const [bg, fg] = groupColor(g.key) ?? ["#F2F3F5", "#646A73"];
              const open = !collapsed.has(g.key);
              return (
                <Fragment key={g.key || "__ungrouped"}>
                  <tr className="bg-sidebar/70" data-group={g.key}>
                    <td colSpan={winFields.length + 3} className="border px-2.5 py-1.5">
                      <button
                        className="flex items-center gap-1.5 text-[13px] font-medium"
                        onClick={() =>
                          setCollapsed((prev) => {
                            const next = new Set(prev);
                            if (open) next.add(g.key);
                            else next.delete(g.key);
                            return next;
                          })
                        }
                      >
                        <ChevronRight size={12} strokeWidth={1.7} className={cn("text-subtle transition-transform", open && "rotate-90")} />
                        {g.key ? (
                          <span className="rounded px-1.5 py-0.5 text-[12px]" style={{ background: bg, color: fg }}>
                            {groupLabel(g.key)}
                          </span>
                        ) : (
                          <span className="rounded bg-accent px-1.5 py-0.5 text-[12px] text-subtle">{t("未分组")}</span>
                        )}
                        <span className="text-subtle">{g.rows.length}</span>
                      </button>
                    </td>
                  </tr>
                  {open && g.rows.map((r) => renderRow(r, idxOf.get(r.id) ?? 0))}
                </Fragment>
              );
            })}
          {canEdit && (
            <tr className="h-8">
              <td colSpan={winFields.length + 3} className="sticky left-0 border px-4">
                <button className="text-[18px] leading-none text-subtle hover:text-foreground" aria-label={t("新增一行")} onClick={() => void addRecord()} disabled={ledger.blocked("record:create")}>
                  +
                </button>
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="group/stats sticky bottom-0 z-10 h-8 bg-surface text-[12px] text-muted-foreground" data-stats-row>
            <td className="sticky left-0 z-10 w-14 border-x-0 border-b-0 border-t bg-surface px-2.5" />
            {winFields.map((f, wi) => {
              const fn = stats[f.id] ?? "";
              const [bg, fg] = fn && groupField && groupField.type === "select" ? (["", ""] as [string, string]) : (["", ""] as [string, string]);
              void bg;
              void fg;
              return (
                <Fragment key={f.id}>
                {wi === nFrozen && leadW > 0 && <td style={{ width: leadW }} className="border-x-0 border-b-0 border-t p-0" aria-hidden />}
                <td className={cn("border-x-0 border-b-0 border-t px-2.5", isFrozen(colOf(wi)) && "sticky z-10 bg-surface")} style={{ width: width(f), ...(isFrozen(colOf(wi)) ? { left: stickyLeft(colOf(wi)) } : {}) }}>
                  <div className={cn("flex items-center gap-1", f.isPrimary && "justify-end")}>
                    {f.isPrimary && !fn && <span data-record-count>{t("{n} 条记录", { n: records.length })}</span>}
                    <select
                      value={fn}
                      onChange={(e) => saveStat(f.id, e.target.value)}
                      className={cn("cursor-pointer bg-transparent text-[12px] outline-none", !fn && "opacity-0 focus:opacity-100 group-hover/stats:opacity-100", f.isPrimary && !fn && "w-4")}
                      title={t("列统计")}
                      data-stat={f.id}
                    >
                      <option value="">—</option>
                      {statFns(f).map((x) => (
                        <option key={x} value={x}>
                          {x === "sum" ? t("求和") : x === "avg" ? t("平均") : x === "count" ? t("计数") : t("空值")}
                        </option>
                      ))}
                    </select>
                    {fn && <span className="tabular-nums">{statValue(f, fn, records)}</span>}
                  </div>
                </td>
                </Fragment>
              );
            })}
            {wjSpacer(leadW, winFields.length) && <td style={{ width: leadW }} className="border-x-0 border-b-0 border-t p-0" aria-hidden />}
            {tailW > 0 && <td style={{ width: tailW }} className="border-x-0 border-b-0 border-t p-0" aria-hidden />}
            {canEdit && <td className="border-x-0 border-b-0 border-t" />}
          </tr>
        </tfoot>
      </table>
    </div>
    </div>
  );
}
