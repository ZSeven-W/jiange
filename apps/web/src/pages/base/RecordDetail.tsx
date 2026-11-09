import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CellEditor, CellView } from "./cells";
import { displayValue, evalFormulas, recordTitle, REGISTRY, setFormulaCache } from "./registry";
import { TypeGlyph } from "./cells";
import { ask } from "@/components/ui/ask";
import { ChevronDown, ChevronUp, MessageSquare, Plus, X } from "lucide-react";
import { FieldForm } from "./fields";

const isBlank = (v: Cell | undefined) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
/** Feishu-style empty-value hints in the record detail. */
function placeholderFor(type: Field["type"]): string {
  if (type === "select" || type === "multi_select") return "请选择选项";
  if (type === "date") return "年/月/日";
  if (type === "person") return "请选择人员";
  if (type === "attachment") return "上传附件";
  return "请输入内容";
}
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
  onPrev,
  onNext,
  position,
}: {
  baseId: number;
  canEdit: boolean;
  preventCopy?: boolean;
  fields: Field[];
  record: BaseRecord;
  members: User[];
  onClose: () => void;
  onMutate: () => void;
  /** Feishu ↑/↓: open the previous/next record of the current view. */
  onPrev?: () => void;
  onNext?: () => void;
  /** 1-based index and total in the current view, for the header. */
  position?: { index: number; total: number };
}) {
  const [tab, setTab] = useState<"detail" | "history">("detail");
  const [addingField, setAddingField] = useState(false);
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
    <aside className="fixed bottom-0 right-0 top-0 z-40 flex w-full max-w-[800px] flex-col border-l bg-surface shadow-[-6px_0_24px_rgba(31,35,41,0.08)] md:top-16" data-record-detail onKeyDown={(event) => event.stopPropagation()} onPaste={(event) => event.stopPropagation()} onCopyCapture={(event) => { if (preventCopy) event.preventDefault(); }} onCutCapture={(event) => { if (preventCopy) event.preventDefault(); }}>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b px-5 text-[13px] text-muted-foreground">
        <button type="button" className="grid size-8 place-items-center rounded-md hover:bg-hover disabled:opacity-40" onClick={onPrev} disabled={!onPrev} aria-label="上一条记录" title="上一条记录" data-record-prev><ChevronUp size={18} strokeWidth={1.7} /></button>
        <button type="button" className="grid size-8 place-items-center rounded-md hover:bg-hover disabled:opacity-40" onClick={onNext} disabled={!onNext} aria-label="下一条记录" title="下一条记录" data-record-next><ChevronDown size={18} strokeWidth={1.7} /></button>
        <span className="ml-1 text-[12px] text-subtle">{position ? `${position.index} / ${position.total}` : null}<span className="ml-2">记录 #{row.id}</span></span>
        <button className="ml-auto grid size-8 place-items-center rounded-md text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label="关闭">
          <X size={18} strokeWidth={1.7} />
        </button>
      </header>
      <div className="shrink-0 px-10 pt-6">
        <h2 className="truncate text-[24px] font-semibold leading-8 text-foreground" data-record-title>{recordTitle(row, fields, members) || "未命名记录"}</h2>
        <div className="mt-4 flex h-9 items-end gap-6 border-b text-[14px]" role="tablist" aria-label="记录详情">
          {(["detail", "history"] as const).map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("-mb-px border-b-2 pb-2", tab === t ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground")} data-record-tab={t}>{t === "detail" ? "详情" : "历史"}</button>)}
        </div>
      </div>
      <WriteIssues ledger={ledger} issues={issues} />
      {tab === "history" ? <RecordHistory baseId={baseId} record={row} fields={fields} members={members} /> : <div className="flex-1 overflow-y-auto" data-record-scroll>
      <div className="px-10 py-3" data-detail-fields>
        {fields.map((f) => {
          const def = REGISTRY[f.type];
          const editingThis = editing?.rid === row.id && editing.fid === f.id;
          return (
            <div key={f.id} className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)] items-start gap-3 py-1">
              <div className="min-w-0 pt-[9px] text-[14px] text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0"><TypeGlyph t={f.type} size={15} /></span>
                  <span className="truncate">{f.name}</span>
                  {def.readonly && <span className="shrink-0 rounded bg-hover px-1 text-[11px] text-subtle">自动</span>}
                </div>
                {f.description && <div className="mt-0.5 text-[11px] leading-4 text-subtle">{f.description}</div>}
              </div>
              <div
                className={cn("flex min-h-9 items-center rounded-md px-2 py-1 text-[14px]", !def.readonly && canEdit && "cursor-text hover:bg-hover", editingThis && "outline outline-2 -outline-offset-2 outline-primary")}
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
                ) : isBlank(row.cells[f.id]) && canEdit && !def.readonly && f.type !== "checkbox" ? (
                  <span className="text-subtle" data-detail-placeholder>{placeholderFor(f.type)}</span>
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
        {canEdit && (
          <div className="relative py-1">
            <button type="button" className="flex h-9 items-center gap-1.5 rounded-md px-1 text-[14px] text-muted-foreground hover:text-foreground" onClick={() => setAddingField((v) => !v)} disabled={ledger.blocked("field:create")} data-detail-add-field><Plus size={16} strokeWidth={1.7} />新增字段</button>
            {addingField && <FieldForm onCancel={() => setAddingField(false)} onAcknowledge={() => ledger.discardKey("field:create")} onSubmit={async (patch) => {
              const op = ledger.begin("新增字段", cellDraft(patch), "field:create");
              if (op === null) throw new Error("previous result unresolved");
              try { await baseApi.addField(baseId, patch); ledger.complete(op); setAddingField(false); }
              catch (error) { ledger.fail(op, "无法确认字段是否创建。请刷新并核对字段列表。"); throw error; }
              finally { refreshWrites(onMutate); }
            }} />}
          </div>
        )}
      </div>
      <ReverseLinks baseId={baseId} recordId={record.id} />
      <RecordComments baseId={baseId} recordId={record.id} />
      </div>}
      <footer className="flex items-center gap-3 border-t px-10 py-2.5 text-[12px] text-subtle">
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


/** 记录历史 tab: field-level changes from the server's event log. */
function RecordHistory({ baseId, record, fields, members }: { baseId: number; record: BaseRecord; fields: Field[]; members: User[] }) {
  const q = useQuery({ queryKey: ["record-history", baseId, record.id, record.updatedAt], queryFn: () => baseApi.recordHistory(baseId, record.id) });
  const show = (f: Field, v: Cell | undefined) => {
    if (v === undefined || v === null) return "空";
    const text = REGISTRY[f.type].format(displayValue({ ...record, cells: { [f.id]: v } }, f, members), f);
    return text || "空";
  };
  const who = (id?: number) => members.find((m) => m.id === id)?.name;
  return (
    <div className="flex-1 overflow-y-auto px-10 py-4" data-record-history>
      {q.isPending ? <p className="text-[13px] text-subtle">加载中…</p> : q.isError ? <p role="alert" className="text-[13px] text-destructive">无法加载历史记录。</p> : q.data.length === 0 ? <p className="text-[13px] text-subtle">暂无历史记录</p> : (
        <ol className="relative space-y-5 border-l border-[#dee0e3] pl-5">
          {q.data.map((e) => (
            <li key={e.seq} className="relative" data-history-entry={e.seq}>
              <span className="absolute -left-[25px] top-1.5 size-2 rounded-full bg-primary/70" />
              <div className="text-[13px]">
                <span className="font-medium">{e.op === "add" ? `${who(e.by) ?? "有人"} 创建了记录` : "修改了记录"}</span>
                {e.at && <span className="ml-2 text-[12px] text-subtle">{new Date(e.at).toLocaleString("zh-CN", { hour12: false })}</span>}
              </div>
              <ul className="mt-1.5 space-y-1 text-[13px]">
                {e.changes.map((c) => {
                  const f = fields.find((x) => x.id === c.f);
                  if (!f) return null;
                  return (
                    <li key={c.f} className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                      <TypeGlyph t={f.type} size={13} /><span>{f.name}</span>
                      {e.op === "update" && <><span className="max-w-[240px] truncate rounded bg-[#f2f3f5] px-1.5 text-subtle line-through">{show(f, c.before)}</span><span>→</span></>}
                      <span className="max-w-[280px] truncate rounded bg-[#e1eaff] px-1.5 text-foreground">{show(f, c.after)}</span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** 记录评论: thread at the bottom of the detail panel. */
function RecordComments({ baseId, recordId }: { baseId: number; recordId: number }) {
  const q = useQuery({ queryKey: ["record-comments", baseId, recordId], queryFn: () => baseApi.recordComments(baseId, recordId) });
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    try { await baseApi.addRecordComment(baseId, recordId, text); setBody(""); await q.refetch(); }
    catch { setError("评论未能确认发送，请刷新后核对。"); }
    finally { setSending(false); }
  };
  return (
    <section className="border-t px-10 py-4" data-record-comments>
      <h3 className="mb-3 flex items-center gap-1.5 text-[14px] font-medium"><MessageSquare size={15} strokeWidth={1.7} />评论{q.data?.length ? <span className="text-subtle">{q.data.length}</span> : null}</h3>
      <div className="space-y-3">
        {(q.data ?? []).map((c) => (
          <div key={c.id} className="flex gap-2.5 text-[13px]" data-record-comment={c.id}>
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#8d6cdf] text-[12px] text-white">{c.userName.slice(0, 1)}</span>
            <div className="min-w-0">
              <div><span className="font-medium">{c.userName}</span><span className="ml-2 text-[12px] text-subtle">{new Date(c.createdAt).toLocaleString("zh-CN", { hour12: false })}</span></div>
              <p className="mt-0.5 whitespace-pre-wrap break-words">{c.body}</p>
            </div>
          </div>
        ))}
        {q.isError && <p role="alert" className="text-[12px] text-destructive">无法加载评论。</p>}
      </div>
      <div className="mt-3 flex items-end gap-2 rounded-lg border px-3 py-2 focus-within:border-primary">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} rows={1} maxLength={2000} placeholder="输入评论，Enter 发送" className="max-h-28 min-h-6 flex-1 resize-none bg-transparent text-[13px] outline-none" data-record-comment-input />
        <button type="button" onClick={() => void send()} disabled={!body.trim() || sending} className="h-7 shrink-0 rounded-md bg-primary px-3 text-[12px] text-white disabled:opacity-40">发送</button>
      </div>
      {error && <p role="alert" className="mt-1 text-[12px] text-destructive">{error}</p>}
    </section>
  );
}
