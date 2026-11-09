import { Fragment, useEffect, useRef, useState } from "react";
import { ApiError, baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CellEditor, CellView } from "./cells";
import { FieldForm, FieldMenu, type FieldMenuAction } from "./fields";
import { RecordDetail } from "./RecordDetail";
import { displayValue, evalFormulas, PALETTE, REGISTRY, setFormulaCache, optionColor } from "./registry";
import { TypeGlyph } from "./cells";
import { planPaste, rangeText, skippedPasteMessage } from "./tsv";
import { ChevronRight, Expand, Lock, Pencil } from "lucide-react";
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
  const [editField, setEditField] = useState<Field | null>(null);
  const [widths, setWidths] = useState<Record<number, number>>(() => loadWidths(baseId));
  const [drag, setDrag] = useState<{ fid: number; at: number | null; order: number[]; allOrder: number[] }>({ fid: 0, at: null, order: [], allOrder: [] });
  const [dragError, setDragError] = useState<string | null>(null);
  const [sel, setSel] = useState<GridSelection | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const detail = authorizedDetailRecord(detailId, authorizedRecords ?? records, detailAccessReady);
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
  const [vp, setVp] = useState({ top: 0, left: 0, h: 900, w: 1200 });
  const gridRef = useRef<HTMLDivElement>(null);
  const current = useRef({ baseId, canEdit, mounted: true, detailAccessReady, selectionAccessReady, authorizedRecords: authorizedRecords ?? records, fields, allFields });
  current.current = { baseId, canEdit, mounted: true, detailAccessReady, selectionAccessReady, authorizedRecords: authorizedRecords ?? records, fields, allFields };
  useEffect(() => { current.current.mounted = true; return () => { current.current.mounted = false; }; }, []);
  useEffect(() => () => {
    const draft = editRef.current;
    if (!draft?.dirty) return;
    const op = ledger.begin(`记录 #${draft.rid} · 字段 #${draft.fid}`, cellDraft(draft.draft), `cell:${draft.rid}:${draft.fid}`, draft.authorization, false, draft.authored);
    if (op !== null) ledger.fail(op, "离开表格时输入尚未提交，请复制后核对。");
    editRef.current = null;
  }, [ledger]);
  useEffect(() => {
    const active = editRef.current;
    if (!active) return;
    if (canEdit && records.some((record) => record.id === active.rid) && fields.some((field) => field.id === active.fid)) return;
    if (active.dirty) {
      const op = ledger.begin(`记录 #${active.rid} · 字段 #${active.fid}`, cellDraft(active.draft), `cell:${active.rid}:${active.fid}`, active.authorization, false, active.authored);
      if (op !== null) ledger.fail(op, "记录、字段或编辑权限已变化；输入未提交，请复制后核对。");
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
    const targetTop = headerHeight + r * 32;
    if (targetTop < el.scrollTop + headerHeight) el.scrollTop = Math.max(0, targetTop - headerHeight);
    else if (targetTop + 32 > el.scrollTop + el.clientHeight) el.scrollTop = targetTop + 32 - el.clientHeight;
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
      const held = ledger.begin(`记录 #${rec.id} · ${f.name}`, raw ?? cellDraft(v), `cell:${rec.id}:${f.id}`, authorization, false, authored);
      if (held !== null) ledger.fail(held, "编辑权限或页面已变化；输入未提交，请复制后核对。");
      return;
    }
    const cur = rec.cells[f.id];
    if (cur === v || (cur === undefined && (v === null || v === ""))) {
      if (dir === "down") move(1, 0);
      if (dir === "right") move(0, 1);
      return;
    }
    const draft = raw ?? cellDraft(v);
    const op = ledger.blocked("batch") ? null : ledger.begin(`记录 #${rec.id} · ${f.name}`, draft, `cell:${rec.id}:${f.id}`, authorization, false, authored);
    if (op === null) { const held = ledger.begin(`记录 #${rec.id} · ${f.name}`, draft, `cell:${rec.id}:${f.id}`, authorization, true, authored); if (held !== null) ledger.fail(held, "尚有未确认的修改，请先核对；本次输入未提交。"); return; }
    if (dir === "down") move(1, 0);
    if (dir === "right") move(0, 1);
    try {
      await baseApi.setCells(baseId, rec.id, { [f.id]: v === "" ? null : v });
      ledger.complete(op);
    } catch {
      ledger.fail(op, CELL_UNKNOWN);
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
    const op = ledger.begin("清空单元格", original, "batch");
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
        ? `已确认清空 ${result.confirmed} 行；数据或权限已变化，后续 ${result.total - result.attempted} 行未尝试。请核对后再操作。`
        : `已确认清空 ${result.confirmed} 行；当前行结果未知，后续 ${result.total - result.attempted} 行未尝试。请核对后再操作。`);
    } catch {
      ledger.fail(op, "清空结果无法确认，请核对后再操作。");
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
    if (!active) { const held = ledger.begin("粘贴", text); if (held !== null) ledger.fail(held, "选区已变化或尚未选择，本次粘贴未提交；请重新选择单元格。"); return; }
    const plan = planPaste(records, fields, Math.min(active.ar, active.rr), Math.min(active.af, active.rf), text);
    const scope = { kind: "paste" as const, ...plan.scope };
    const total = plan.patches.length + plan.addRows.length;
    if (!total) { const held = ledger.begin("粘贴", text, undefined, undefined, false, true, scope); if (held !== null) ledger.fail(held, `${plan.skipped.length ? skippedPasteMessage(plan.skipped) : "没有可粘贴的内容。"}本次粘贴未提交。`, plan.skipped.length ? skippedPasteMessage(plan.skipped) : undefined); return; }
    const op = ledger.hasCellWrites() ? null : ledger.begin("粘贴", text, "batch", undefined, false, true, scope);
    if (op === null) { const held = ledger.begin("粘贴", text, undefined, undefined, false, true, scope); if (held !== null) ledger.fail(held, "尚有未确认的修改，请先核对；本次粘贴未提交。"); return; }
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
      else if (result.complete) ledger.fail(op, `已确认处理 ${result.confirmed} 行。${skippedPasteMessage(plan.skipped)}原始内容已保留，请核对后再操作，勿直接重复粘贴。`, skippedPasteMessage(plan.skipped));
      else ledger.fail(op, `${result.attempted === result.confirmed ? `已确认处理 ${result.confirmed} 行；数据或权限已变化，后续 ${result.total - result.attempted} 行未尝试。` : `已确认处理 ${result.confirmed} 行；当前行结果未知，后续 ${result.total - result.attempted} 行未尝试。`}${plan.skipped.length ? skippedPasteMessage(plan.skipped) : ""}新增行可能已创建，请核对后再操作，勿直接重复粘贴。`, plan.skipped.length ? skippedPasteMessage(plan.skipped) : "粘贴结果未全部确认，请先核对。");
    } catch {
      ledger.fail(op, "粘贴结果无法确认，请核对记录后再操作，勿直接重复粘贴。");
    } finally { refreshWrites(onMutate); }
  };

  const addRecord = async () => {
    const op = ledger.begin("新增记录", "", "record:create");
    if (op === null) return;
    try { await baseApi.addRecord(baseId); ledger.complete(op); }
    catch { ledger.fail(op, "无法确认是否创建。请刷新并核对记录，勿直接重复新增。"); }
    finally { refreshWrites(onMutate); }
  };

  const deleteRecord = async (rec: BaseRecord) => {
    const op = ledger.begin(`删除记录 #${rec.id}`, "", `record:delete:${rec.id}`);
    if (op === null) return;
    try { await baseApi.deleteRecord(baseId, rec.id); ledger.complete(op); }
    catch { ledger.fail(op, "无法确认是否删除。请刷新并核对记录。"); }
    finally { refreshWrites(onMutate); }
  };

  const deleteField = async (f: Field) => {
    if (!current.current.mounted || current.current.baseId !== baseId || !current.current.canEdit) return;
    const op = ledger.begin(`删除字段「${f.name}」`, "", `field:delete:${f.id}`);
    if (op === null) return;
    try { await baseApi.deleteField(baseId, f.id); ledger.complete(op); }
    catch { ledger.fail(op, "无法确认字段是否删除。请刷新并核对字段列表。"); }
    finally { refreshWrites(onMutate); }
  };

  const saveField = async (patch: Partial<Field>, fid?: number) => {
    if (!current.current.mounted || current.current.baseId !== baseId || !current.current.canEdit) throw new Error("editing unavailable");
    const label = fid === undefined ? "新增字段" : `修改字段 #${fid}`;
    const op = ledger.begin(label, cellDraft(patch), fid === undefined ? "field:create" : `field:edit:${fid}`);
    if (op === null) throw new Error("previous result unresolved");
    try {
      if (fid === undefined) await baseApi.addField(baseId, patch);
      else await baseApi.patchField(baseId, fid, patch);
      ledger.complete(op);
    } catch (error) {
      ledger.fail(op, "无法确认字段是否已保存。请刷新并核对字段列表，勿直接重复提交。");
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
    if (!current.current.mounted || !current.current.canEdit || !current.current.detailAccessReady || !current.current.selectionAccessReady) { setDragError("正在确认权限，请稍后重新拖动字段。"); return; }
    const full = current.current.allFields;
    if (!full || full.length !== allOrder.length || !allOrder.every((id, i) => full[i]?.id === id)) { setDragError("字段顺序已变化，请刷新后重新拖动。"); return; }
    const plan = planFieldReorder(current.current.fields, fid, index, order);
    if (plan.kind === "noop") return;
    if (plan.kind !== "move") { setDragError("字段顺序已变化或无法安全调整，请刷新后重新拖动。"); return; }
    const desired = mergeVisibleFieldOrder(allOrder, order, plan.desiredIds);
    if (!desired) { setDragError("无法确认完整字段顺序，请刷新后重新拖动。"); return; }
    const op = ledger.begin("调整字段顺序", "", `field:order:${fid}`);
    if (op === null) return;
    try { await baseApi.reorderFields(baseId, allOrder, desired); ledger.complete(op); }
    catch (error) {
      if (error instanceof ApiError && error.status === 409) { ledger.complete(op); setDragError("字段顺序已变化，未执行拖动，请刷新后重试。"); }
      else ledger.fail(op, "无法确认顺序是否已保存，请刷新并核对。");
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
    for (const r of records) {
      const raw = displayValue(r, groupField, members);
      const key = raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0) ? "" : String(raw);
      let g = index.get(key);
      if (!g) {
        g = { key, rows: [] };
        index.set(key, g);
        groups.push(g);
      }
      g.rows.push(r);
    }
  }
  const groupColor = (key: string) => (groupField && groupField.type === "select" && key ? optionColor(groupField, key) : null);
  const idxOf = new Map(records.map((r, i) => [r.id, i]));

  // --- virtualization: render only the visible window (plus overscan) ---
  const ROW_H = 32; // h-8
  const OVERSCAN = 6;
  const r0 = Math.max(0, Math.floor(vp.top / ROW_H) - OVERSCAN);
  const r1 = Math.min(rows, Math.ceil((vp.top + vp.h) / ROW_H) + OVERSCAN);
  const colOffsets = fields.reduce<number[]>((acc, f, i) => [...acc, (acc[i - 1] ?? 0) + width(f)], []);
  const totalW = colOffsets[cols - 1] ?? 0;
  let c0 = 0;
  while (c0 < cols && colOffsets[c0] < vp.left - 200) c0++;
  c0 = Math.max(0, c0 - 2);
  let c1 = c0;
  while (c1 < cols && colOffsets[c1] < vp.left + vp.w + 200) c1++;
  c1 = Math.min(cols, c1 + 2);
  const leadW = c0 > 0 ? colOffsets[c0 - 1] : 0;
  const tailW = c1 < cols ? totalW - (colOffsets[c1 - 1] ?? 0) : 0;
  const winFields = fields.slice(c0, c1);

  const renderRow = (rec: BaseRecord, i: number) => (
            <tr key={rec.id} className="group h-8">
              <td className="sticky left-0 z-10 w-14 border border-x-0 bg-surface px-2.5 text-[12px] text-subtle [@media(hover:none)]:px-1">
                <div className="flex h-[31px] items-center justify-center">
                <span className="group-hover:hidden [@media(hover:none)]:inline">{i + 1}</span>
                <span className="hidden items-center justify-center gap-0.5 group-hover:flex [@media(hover:none)]:flex">
                  <button type="button" className="grid size-6 touch-manipulation place-items-center rounded text-subtle hover:text-primary [@media(hover:none)]:size-8" aria-label={`展开记录 ${i + 1}`} title="展开记录" onClick={() => { setDetailId(rec.id); onDetailVisibilityChange?.(true); }} data-expand={rec.id}>
                    <Expand size={14} strokeWidth={1.7} />
                  </button>
                  {canEdit && (
                    <button type="button" className="text-subtle hover:text-destructive [@media(hover:none)]:hidden" title="删除记录" onClick={() => void deleteRecord(rec)}>
                      ✕
                    </button>
                  )}
                </span>
                </div>
              </td>
              {leadW > 0 && <td style={{ width: leadW }} className="border p-0" aria-hidden />}
              {winFields.map((f, wj) => {
                const j = c0 + wj;
                const editing = edit?.rid === rec.id && edit.fid === f.id;
                const ro = REGISTRY[f.type].readonly;
                return (
                  <td
                    key={f.id}
                    className={cn(
                      "relative border px-2.5",
                      f.isPrimary && "border-l-0 border-r-[#BBBFC4]",
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
                        onInvalid={(raw) => { const op = ledger.begin(`记录 #${rec.id} · ${f.name}`, raw, `cell:${rec.id}:${f.id}`, editRef.current?.authorization, false, editRef.current?.authored ?? false); if (op !== null) ledger.fail(op, "输入格式无效，未保存；请复制后修改。"); }}
                      />
                    ) : <div className="flex h-[31px] min-w-0 items-center overflow-hidden" data-grid-cell-content>
                      <CellView
                        field={f}
                        record={rec}
                        members={members}
                        compact
                        canEdit={canEdit && !ro}
                        onToggle={canEdit && !ro ? () => toggleAt(i, j) : undefined}
                        onEdit={() => startEdit(i, j)}
                      />
                      {canEdit && detailAccessReady && selectionAccessReady && isCursor(i, j) && !ro && f.type !== "checkbox" && f.type !== "link" && f.type !== "lookup" && !ledger.blocked("batch") && !ledger.blocked(`cell:${rec.id}:${f.id}`) && <button type="button" data-touch-edit className="absolute right-0 top-0 hidden size-8 touch-manipulation items-center justify-center rounded bg-surface text-primary shadow-sm [@media(hover:none)]:inline-flex" aria-label={`编辑记录 ${i + 1} 的${f.name}`} onClick={(event) => { event.stopPropagation(); startEdit(i, j); }}><Pencil size={14} strokeWidth={1.7} /></button>}
                    </div>}
                  </td>
                );
              })}
              {tailW > 0 && <td style={{ width: tailW }} className="border p-0" aria-hidden />}
              {canEdit && <td className="border" />}
            </tr>
              );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {dragError && <p role="alert" className="border-b px-3 py-2 text-[12px] text-destructive">{dragError}</p>}
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
      {detailId !== null && !detailAccessReady && <aside className="fixed inset-y-0 right-0 z-40 grid w-full max-w-[420px] place-items-center border-l bg-surface text-[13px] text-subtle shadow-xl" role="status">正在确认记录访问权限…</aside>}
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
        />
      )}
      <table
        className="border-collapse table-fixed text-[14px]"
        data-grid
        style={{ width: 56 + totalW + (canEdit ? 44 : 0) }}
      >
        <thead>
          <tr className="h-9 bg-surface text-left text-[13px] text-foreground">
            <th className="sticky left-0 top-0 z-40 w-14 border border-x-0 bg-surface px-2.5 font-normal" />
            {leadW > 0 && <th style={{ width: leadW }} className="border p-0" aria-hidden />}
            {winFields.map((f, wi) => {
              const i = c0 + wi;
              return (
              <th
                key={f.id}
                className={cn("group/th sticky top-0 z-30 border bg-surface px-2.5 font-normal", f.isPrimary && "border-l-0 border-r-[#BBBFC4]", drag.at === i && drag.fid && drag.fid !== f.id && "border-l-2 border-l-primary")}
                style={{ width: width(f), minWidth: width(f) }}
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
                    {!f.isPrimary && <span className="mr-0.5 hidden cursor-grab text-subtle group-hover/th:inline" title="拖拽排序" data-drag-handle>
                      ⠿
                    </span>}
                    {f.isPrimary && <Lock size={13} className="shrink-0 text-subtle" aria-label="主字段" />}
                    <span className="mr-1 text-muted-foreground"><TypeGlyph t={f.type} size={14} /></span>
                    <span className="truncate">{f.name}</span>
                    {canEdit && (
                      <span className="ml-auto">
                        <FieldMenu field={f} onEdit={() => setEditField(f)} onDelete={() => void deleteField(f)} onDuplicate={() => void saveField({ name: `${f.name} 副本`, type: f.type, options: f.options, optionColors: f.optionColors, formula: f.formula, description: f.description }).catch(() => undefined)} onAction={onFieldAction ? (action) => onFieldAction(action, f) : undefined} />
                      </span>
                    )}
                  </div>
                {editField?.id === f.id && <FieldForm initial={f} onCancel={() => setEditField(null)} onSubmit={(patch) => saveField(patch, f.id)} onAcknowledge={() => ledger.discardKey(`field:edit:${f.id}`)} />}
                {canEdit && <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40" onMouseDown={(e) => startResize(e, f)} data-resize={f.id} />}
              </th>
              );
            })}
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
                <button className="size-full text-[16px] text-subtle hover:text-foreground" onClick={() => setNewField((v) => !v)} aria-label="添加字段" disabled={ledger.blocked("field:create")}>
                  +
                </button>
                {newField && <FieldForm onCancel={() => setNewField(false)} onSubmit={(f) => saveField(f)} onAcknowledge={() => ledger.discardKey("field:create")} />}
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
                            {g.key}
                          </span>
                        ) : (
                          <span className="rounded bg-accent px-1.5 py-0.5 text-[12px] text-subtle">未分组</span>
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
                <button className="text-[18px] leading-none text-subtle hover:text-foreground" aria-label="新增一行" onClick={() => void addRecord()} disabled={ledger.blocked("record:create")}>
                  +
                </button>
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="group/stats sticky bottom-0 z-10 h-8 bg-surface text-[12px] text-muted-foreground" data-stats-row>
            <td className="sticky left-0 z-10 w-14 border-x-0 border-b-0 border-t bg-surface px-2.5" />
            {leadW > 0 && <td style={{ width: leadW }} className="border-x-0 border-b-0 border-t p-0" aria-hidden />}
            {winFields.map((f) => {
              const fn = stats[f.id] ?? "";
              const [bg, fg] = fn && groupField && groupField.type === "select" ? (["", ""] as [string, string]) : (["", ""] as [string, string]);
              void bg;
              void fg;
              return (
                <td key={f.id} className="border-x-0 border-b-0 border-t px-2.5" style={{ width: width(f) }}>
                  <div className={cn("flex items-center gap-1", f.isPrimary && "justify-end")}>
                    {f.isPrimary && !fn && <span data-record-count>{records.length} 条记录</span>}
                    <select
                      value={fn}
                      onChange={(e) => saveStat(f.id, e.target.value)}
                      className={cn("cursor-pointer bg-transparent text-[12px] outline-none", !fn && "opacity-0 focus:opacity-100 group-hover/stats:opacity-100", f.isPrimary && !fn && "w-4")}
                      title="列统计"
                      data-stat={f.id}
                    >
                      <option value="">—</option>
                      {statFns(f).map((x) => (
                        <option key={x} value={x}>
                          {x === "sum" ? "求和" : x === "avg" ? "平均" : x === "count" ? "计数" : "空值"}
                        </option>
                      ))}
                    </select>
                    {fn && <span className="tabular-nums">{statValue(f, fn, records)}</span>}
                  </div>
                </td>
              );
            })}
            {tailW > 0 && <td style={{ width: tailW }} className="border-x-0 border-b-0 border-t p-0" aria-hidden />}
            {canEdit && <td className="border-x-0 border-b-0 border-t" />}
          </tr>
        </tfoot>
      </table>
    </div>
    </div>
  );
}
