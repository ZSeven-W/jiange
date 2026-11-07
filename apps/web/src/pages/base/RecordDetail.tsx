import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CellEditor, CellView } from "./cells";
import { displayValue, evalFormulas, recordTitle, REGISTRY, setFormulaCache } from "./registry";
import { TypeGlyph } from "./cells";
import { ask } from "@/components/ui/ask";
import { CELL_UNKNOWN, cellDraft, isAuthoredCellType, refreshWrites, useWriteLedger, WriteIssues, type WriteLedger } from "./writeSafety";

/** Record detail drawer: every field editable in place, like Feishu's
 * row-expansion panel. */
export function RecordDetail({
  baseId,
  canEdit,
  preventCopy = false,
  fields,
  record,
  members,
  onClose,
  onMutate,
}: {
  baseId: number;
  canEdit: boolean;
  preventCopy?: boolean;
  fields: Field[];
  record: BaseRecord;
  members: User[];
  onClose: () => void;
  onMutate: () => void;
}) {
  const { ledger, issues } = useWriteLedger(baseId);
  type DetailEdit = { rid: number; fid: number; draft: Cell | null; dirty: boolean; authorization: string | null; authored: boolean };
  const [editing, setEditingState] = useState<DetailEdit | null>(null);
  const editingRef = useRef<DetailEdit | null>(null);
  const setEditing = (next: DetailEdit | null | ((current: DetailEdit | null) => DetailEdit | null)) => {
    const value = typeof next === "function" ? next(editingRef.current) : next;
    editingRef.current = value;
    setEditingState(value);
  };
  // Render only the current authorized projection. Keeping an older local
  // record until an effect runs can briefly reveal newly hidden cell values.
  const row = record;
  const target = useRef({ baseId, recordId: record.id, canEdit, mounted: true });
  target.current = { baseId, recordId: record.id, canEdit, mounted: true };
  useEffect(() => { target.current.mounted = true; return () => { target.current.mounted = false; }; }, []);
  useEffect(() => () => {
    const draft = editingRef.current;
    if (!draft?.dirty) return;
    const op = ledger.begin(`记录 #${draft.rid} · 字段 #${draft.fid}`, cellDraft(draft.draft), `cell:${draft.rid}:${draft.fid}`, draft.authorization, false, draft.authored);
    if (op !== null) ledger.fail(op, "关闭记录时输入尚未提交，请复制后核对。");
    editingRef.current = null;
  }, [ledger]);
  useEffect(() => {
    const active = editingRef.current;
    if (!active) return;
    if (canEdit && active.rid === record.id && fields.some((field) => field.id === active.fid)) return;
    if (active.dirty) {
      const op = ledger.begin(`记录 #${active.rid} · 字段 #${active.fid}`, cellDraft(active.draft), `cell:${active.rid}:${active.fid}`, active.authorization, false, active.authored);
      if (op !== null) ledger.fail(op, "记录、字段或编辑权限已变化；输入未提交，请复制后核对。");
    }
    setEditing(null);
  }, [canEdit, record.id, fields, editing, ledger]);

  setFormulaCache(row, evalFormulas(fields, row, members));
  const setCell = async (f: Field, v: Cell | null, raw?: string) => {
    const existing = editingRef.current;
    const authorization = existing?.rid === row.id && existing.fid === f.id ? existing.authorization : undefined;
    const authored = existing?.rid === row.id && existing.fid === f.id ? existing.authored : raw !== undefined && isAuthoredCellType(f.type);
    setEditing(null);
    if (!target.current.mounted || target.current.baseId !== baseId || target.current.recordId !== row.id || !target.current.canEdit) {
      const held = ledger.begin(`记录 #${row.id} · ${f.name}`, raw ?? cellDraft(v), `cell:${row.id}:${f.id}`, authorization, false, authored);
      if (held !== null) ledger.fail(held, "编辑权限或记录已变化；输入未提交，请复制后核对。");
      return;
    }
    const cur = row.cells[f.id];
    if (cur === v || (cur === undefined && (v === null || v === ""))) return;
    const recordId = row.id;
    const draft = raw ?? cellDraft(v);
    const op = ledger.blocked("batch") ? null : ledger.begin(`记录 #${recordId} · ${f.name}`, draft, `cell:${recordId}:${f.id}`, authorization, false, authored);
    if (op === null) { const held = ledger.begin(`记录 #${recordId} · ${f.name}`, draft, `cell:${recordId}:${f.id}`, authorization, true, authored); if (held !== null) ledger.fail(held, "尚有未确认的修改，请先核对；本次输入未提交。"); return; }
    try {
      await baseApi.setCells(baseId, recordId, { [f.id]: v === "" ? null : v });
      ledger.complete(op);
    } catch { ledger.fail(op, CELL_UNKNOWN); }
    finally { refreshWrites(onMutate); }
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] flex-col border-l bg-surface shadow-xl" data-record-detail onKeyDown={(event) => event.stopPropagation()} onPaste={(event) => event.stopPropagation()} onCopyCapture={(event) => { if (preventCopy) event.preventDefault(); }} onCutCapture={(event) => { if (preventCopy) event.preventDefault(); }}>
      <header className="flex h-[52px] shrink-0 items-center border-b px-4 text-[15px] font-semibold">
        <span className="truncate">
          {recordTitle(row, fields, members) || "未命名记录"}
        </span>
        <span className="ml-2 text-[12px] font-normal text-subtle">#{row.id}</span>
        <button className="ml-auto rounded p-1 text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>
      <WriteIssues ledger={ledger} issues={issues} />
      <div className="flex-1 overflow-y-auto p-4" data-detail-fields>
        {fields.map((f) => {
          const def = REGISTRY[f.type];
          const editingThis = editing?.rid === row.id && editing.fid === f.id;
          return (
            <div key={f.id} className="border-b py-2.5 last:border-b-0">
              <div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <span className="text-subtle"><TypeGlyph t={f.type} /></span>
                {f.name}
                {def.readonly && <span className="rounded bg-hover px-1 text-[11px] text-subtle">自动</span>}
              </div>
              {f.description && <div className="mb-1 text-[11px] leading-4 text-subtle">{f.description}</div>}
              <div
                className={cn("min-h-8 rounded px-1.5 py-1 text-[14px]", !def.readonly && canEdit && "cursor-text hover:bg-hover", editingThis && "outline outline-2 -outline-offset-2 outline-primary")}
                onClick={() => !editingThis && !def.readonly && canEdit && !ledger.blocked("batch") && !ledger.blocked(`cell:${row.id}:${f.id}`) && f.type !== "checkbox" && f.type !== "link" && setEditing({ rid: row.id, fid: f.id, draft: displayValue(row, f, members) ?? null, dirty: false, authorization: ledger.capture(`cell:${row.id}:${f.id}`, isAuthoredCellType(f.type)), authored: isAuthoredCellType(f.type) })}
                data-detail-field={f.id}
              >
                {f.type === "link" && canEdit ? (
                  <LinkEditor baseId={baseId} field={f} record={row} ledger={ledger} onMutate={onMutate} />
                ) : editingThis ? (
                  <CellEditor
                    field={f}
                    record={row}
                    members={members}
                    draft={editingRef.current?.draft}
                    onDraft={(draft) => { const previous = editingRef.current; if (previous?.rid === row.id && previous.fid === f.id) editingRef.current = { ...previous, draft, dirty: true }; }}
                    onCommit={(v, _dir, raw) => void setCell(f, v, raw)}
                    onCancel={() => setEditing(null)}
                    onInvalid={(raw) => { const op = ledger.begin(`记录 #${row.id} · ${f.name}`, raw, `cell:${row.id}:${f.id}`, editingRef.current?.authorization, false, editingRef.current?.authored ?? false); if (op !== null) ledger.fail(op, "输入格式无效，未保存；请复制后修改。"); }}
                  />
                ) : (
                  <CellView
                    field={f}
                    record={row}
                    members={members}
                    canEdit={canEdit && !def.readonly && !ledger.blocked("batch") && !ledger.blocked(`cell:${row.id}:${f.id}`)}
                    onToggle={canEdit && !def.readonly && !ledger.blocked("batch") && !ledger.blocked(`cell:${row.id}:${f.id}`) ? (v) => void setCell(f, v) : undefined}
                    onEdit={() => setEditing({ rid: row.id, fid: f.id, draft: displayValue(row, f, members) ?? null, dirty: false, authorization: ledger.capture(`cell:${row.id}:${f.id}`, isAuthoredCellType(f.type)), authored: isAuthoredCellType(f.type) })}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <ReverseLinks baseId={baseId} recordId={record.id} />
      <footer className="flex items-center gap-3 border-t px-4 py-2.5 text-[12px] text-subtle">
        <span>创建于 {row.createdAt ? new Date(row.createdAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</span>
        <span>修改于 {row.updatedAt ? new Date(row.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</span>
        {canEdit && (
          <button
            className="ml-auto text-destructive hover:underline"
            onClick={async () => {
              if (await ask("删除这条记录？")) {
                if (!target.current.mounted || target.current.baseId !== baseId || target.current.recordId !== row.id) return;
                const op = ledger.begin(`删除记录 #${row.id}`, "", `record:delete:${row.id}`);
                if (op === null) return;
                try {
                  await baseApi.deleteRecord(baseId, row.id);
                  ledger.complete(op);
                  if (target.current.mounted && target.current.baseId === baseId && target.current.recordId === row.id) onClose();
                } catch { ledger.fail(op, "无法确认是否删除。请刷新并核对记录。"); }
                finally { refreshWrites(onMutate); }
              }
            }}
          >
            删除记录
          </button>
        )}
      </footer>
    </aside>
  );
}

/** Link 字段编辑器：勾选目标 base 的记录，保存为 id 数组（真值在 bt_links）。 */
function LinkEditor({
  baseId,
  field,
  record,
  ledger,
  onMutate,
}: {
  baseId: number;
  field: Field;
  record: BaseRecord;
  ledger: WriteLedger;
  onMutate: () => void;
}) {
  const members: User[] = [];
  const targetBase = Number(field.options?.[0] ?? 0);
  const target = useQuery({
    queryKey: ["base", targetBase],
    queryFn: ({ signal }) => baseApi.get(targetBase, signal),
    enabled: targetBase > 0,
    refetchOnMount: "always",
  });
  const selected = Array.isArray(record.cells[field.id]) ? (record.cells[field.id] as unknown[]).map(Number) : [];
  const targetReady = target.isFetchedAfterMount && target.isSuccess && !target.isFetching;
  const targetData = targetReady ? target.data : undefined;
  const toggle = async (id: number) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    const op = ledger.blocked("batch") ? null : ledger.begin(`记录 #${record.id} · ${field.name}`, cellDraft(next), `cell:${record.id}:${field.id}`);
    if (op === null) return;
    try { await baseApi.setCells(baseId, record.id, { [String(field.id)]: next }); ledger.complete(op); }
    catch { ledger.fail(op, CELL_UNKNOWN); }
    finally { refreshWrites(onMutate); }
  };
  if (!targetBase) return <span className="text-[12px] text-subtle">未配置目标表</span>;
  return (
    <div className="max-h-40 space-y-0.5 overflow-y-auto" data-link-editor>
      {(targetData?.records ?? []).map((r) => (
        <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-hover">
          <input
            type="checkbox"
            className="accent-primary"
            checked={selected.includes(r.id)}
            disabled={ledger.blocked("batch") || ledger.blocked(`cell:${record.id}:${field.id}`)}
            onChange={() => void toggle(r.id)}
          />
          {(targetData && recordTitle(r, targetData.fields, targetData.members ?? [])) || `#${r.id}`}
        </label>
      ))}
      {target.isError ? <span role="alert" className="text-[12px] text-destructive">无法加载目标表，请重试。</span> : !targetReady ? <span role="status" className="text-[12px] text-subtle">正在确认目标表访问权限…</span> : (targetData?.records ?? []).length === 0 && <span className="text-[12px] text-subtle">目标表暂无记录</span>}
    </div>
  );
}


/** 双向关联：列出反向引用本记录的源记录（只读 chips）。 */
function ReverseLinks({ baseId, recordId }: { baseId: number; recordId: number }) {
  const rev = useQuery({ queryKey: ["reverse", baseId], queryFn: () => baseApi.reverse(baseId) });
  const rows = (rev.data ?? [])
    .map((r) => ({
      sourceBase: r.sourceBase,
      refs: r.from[String(recordId)] ?? [],
      titles: r.titles,
    }))
    .filter((x) => x.refs.length > 0);
  if (rows.length === 0) return null;
  return (
    <div className="border-t px-4 py-3" data-reverse-links>
      <div className="mb-1.5 text-[12px] text-muted-foreground">被以下记录关联</div>
      {rows.map((r) => (
        <div key={r.sourceBase} className="mb-1.5 flex flex-wrap gap-1">
          {r.refs.map((rid) => (
            <span key={rid} className="rounded bg-[#E1EAFF] px-1.5 py-0.5 text-[12px] font-medium text-primary dark:bg-[#1d3461]">
              {r.titles[String(rid)] ?? `#${rid}`}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
