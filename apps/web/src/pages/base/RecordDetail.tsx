import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, baseApi, commentsApi, REACTION_EMOJIS, type BaseRecord, type Cell, type Comment, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CellEditor, CellView } from "./cells";
import { displayValue, evalFormulas, recordTitle, REGISTRY, setFormulaCache } from "./registry";
import { TypeGlyph } from "./cells";
import { ask } from "@/components/ui/ask";
import { ChevronDown, ChevronUp, MessageSquare, Plus, SmilePlus, X } from "lucide-react";
import { FieldForm } from "./fields";
import { historyActorName, historyHeadline } from "./historyActor";
import { t, useI18n } from "@/lib/i18n";
import { mentionQuery, mentionsIn, splitMentions, threadComments, type Thread } from "./recordComments";
import { Avatar } from "@/components/brand";
import { colorFor } from "@/lib/presence";

const isBlank = (v: Cell | undefined) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
/** Feishu-style empty-value hints in the record detail. */
function placeholderFor(type: Field["type"]): string {
  if (type === "select" || type === "multi_select") return t("请选择选项");
  if (type === "date") return t("年/月/日");
  if (type === "person") return t("请选择人员");
  if (type === "attachment") return t("上传附件");
  return t("请输入内容");
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
    const op = ledger.begin(t("记录 #{rid} · 字段 #{fid}", { rid: draft.rid, fid: draft.fid }), cellDraft(draft.draft), `cell:${draft.rid}:${draft.fid}`, draft.authorization, false, draft.authored);
    if (op !== null) ledger.fail(op, t("关闭记录时输入尚未提交，请复制后核对。"));
    editingRef.current = null;
  }, [ledger]);
  useEffect(() => {
    const active = editingRef.current;
    if (!active) return;
    if (canEdit && active.rid === record.id && fields.some((field) => field.id === active.fid)) return;
    if (active.dirty) {
      const op = ledger.begin(t("记录 #{rid} · 字段 #{fid}", { rid: active.rid, fid: active.fid }), cellDraft(active.draft), `cell:${active.rid}:${active.fid}`, active.authorization, false, active.authored);
      if (op !== null) ledger.fail(op, t("记录、字段或编辑权限已变化；输入未提交，请复制后核对。"));
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
      const held = ledger.begin(t("记录 #{rid} · {field}", { rid: row.id, field: f.name }), raw ?? cellDraft(v), `cell:${row.id}:${f.id}`, authorization, false, authored);
      if (held !== null) ledger.fail(held, t("编辑权限或记录已变化；输入未提交，请复制后核对。"));
      return;
    }
    const cur = row.cells[f.id];
    if (cur === v || (cur === undefined && (v === null || v === ""))) return;
    const recordId = row.id;
    const draft = raw ?? cellDraft(v);
    const op = ledger.blocked("batch") ? null : ledger.begin(t("记录 #{rid} · {field}", { rid: recordId, field: f.name }), draft, `cell:${recordId}:${f.id}`, authorization, false, authored);
    if (op === null) { const held = ledger.begin(`记录 #${recordId} · ${f.name}`, draft, `cell:${recordId}:${f.id}`, authorization, true, authored); if (held !== null) ledger.fail(held, t("尚有未确认的修改，请先核对；本次输入未提交。")); return; }
    try {
      await baseApi.setCells(baseId, recordId, { [f.id]: v === "" ? null : v });
      ledger.complete(op);
    } catch { ledger.fail(op, t(CELL_UNKNOWN)); }
    finally { refreshWrites(onMutate); }
  };

  return (
    <aside className="fixed bottom-0 right-0 top-0 z-40 flex w-full max-w-[800px] flex-col border-l bg-surface shadow-[-6px_0_24px_rgba(31,35,41,0.08)] md:top-16" data-record-detail onKeyDown={(event) => event.stopPropagation()} onPaste={(event) => event.stopPropagation()} onCopyCapture={(event) => { if (preventCopy) event.preventDefault(); }} onCutCapture={(event) => { if (preventCopy) event.preventDefault(); }}>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b px-5 text-[13px] text-muted-foreground">
        <button type="button" className="grid size-8 place-items-center rounded-md hover:bg-hover disabled:opacity-40" onClick={onPrev} disabled={!onPrev} aria-label={t("上一条记录")} title={t("上一条记录")} data-record-prev><ChevronUp size={18} strokeWidth={1.7} /></button>
        <button type="button" className="grid size-8 place-items-center rounded-md hover:bg-hover disabled:opacity-40" onClick={onNext} disabled={!onNext} aria-label={t("下一条记录")} title={t("下一条记录")} data-record-next><ChevronDown size={18} strokeWidth={1.7} /></button>
        <span className="ml-1 text-[12px] text-subtle">{position ? `${position.index} / ${position.total}` : null}<span className="ml-2">{t("记录 #{id}", { id: row.id })}</span></span>
        <button className="ml-auto grid size-8 place-items-center rounded-md text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label={t("关闭")}>
          <X size={18} strokeWidth={1.7} />
        </button>
      </header>
      <div className="shrink-0 px-10 pt-6">
        <h2 className="truncate text-[24px] font-semibold leading-8 text-foreground" data-record-title>{recordTitle(row, fields, members) || t("未命名记录")}</h2>
        <div className="mt-4 flex h-9 items-end gap-6 border-b text-[14px]" role="tablist" aria-label={t("记录详情")}>
          {(["detail", "history"] as const).map((tKey) => <button key={tKey} type="button" role="tab" aria-selected={tab === tKey} onClick={() => setTab(tKey)} className={cn("-mb-px border-b-2 pb-2", tab === tKey ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground")} data-record-tab={tKey}>{tKey === "detail" ? t("详情") : t("历史")}</button>)}
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
                  {def.readonly && <span className="shrink-0 rounded bg-hover px-1 text-[11px] text-subtle">{t("自动")}</span>}
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
                    onInvalid={(raw) => { const op = ledger.begin(`记录 #${row.id} · ${f.name}`, raw, `cell:${row.id}:${f.id}`, editingRef.current?.authorization, false, editingRef.current?.authored ?? false); if (op !== null) ledger.fail(op, t("输入格式无效，未保存；请复制后修改。")); }}
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
            <button type="button" className="flex h-9 items-center gap-1.5 rounded-md px-1 text-[14px] text-muted-foreground hover:text-foreground" onClick={() => setAddingField((v) => !v)} disabled={ledger.blocked("field:create")} data-detail-add-field><Plus size={16} strokeWidth={1.7} />{t("新增字段")}</button>
            {addingField && <FieldForm members={members} onCancel={() => setAddingField(false)} onAcknowledge={() => ledger.discardKey("field:create")} onSubmit={async (patch) => {
              const op = ledger.begin(t("新增字段"), cellDraft(patch), "field:create");
              if (op === null) throw new Error("previous result unresolved");
              try { await baseApi.addField(baseId, patch); ledger.complete(op); setAddingField(false); }
              catch (error) { ledger.fail(op, t("无法确认字段是否创建。请刷新并核对字段列表。")); throw error; }
              finally { refreshWrites(onMutate); }
            }} />}
          </div>
        )}
      </div>
      <ReverseLinks baseId={baseId} recordId={record.id} />
      <RecordComments baseId={baseId} recordId={record.id} />
      </div>}
      <footer className="flex items-center gap-3 border-t px-10 py-2.5 text-[12px] text-subtle">
        <span>{t("创建于 {time}", { time: row.createdAt ? new Date(row.createdAt).toLocaleString("zh-CN", { hour12: false }) : "—" })}</span>
        <span>{t("修改于 {time}", { time: row.updatedAt ? new Date(row.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "—" })}</span>
        {canEdit && (
          <button
            className="ml-auto text-destructive hover:underline"
            onClick={async () => {
              if (await ask(t("删除这条记录？"))) {
                if (!target.current.mounted || target.current.baseId !== baseId || target.current.recordId !== row.id) return;
                const op = ledger.begin(t("删除记录 #{id}", { id: row.id }), "", `record:delete:${row.id}`);
                if (op === null) return;
                try {
                  await baseApi.deleteRecord(baseId, row.id);
                  ledger.complete(op);
                  if (target.current.mounted && target.current.baseId === baseId && target.current.recordId === row.id) onClose();
                } catch { ledger.fail(op, t("无法确认是否删除。请刷新并核对记录。")); }
                finally { refreshWrites(onMutate); }
              }
            }}
          >
            {t("删除记录")}
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
    const op = ledger.blocked("batch") ? null : ledger.begin(t("记录 #{rid} · {field}", { rid: record.id, field: field.name }), cellDraft(next), `cell:${record.id}:${field.id}`);
    if (op === null) return;
    try { await baseApi.setCells(baseId, record.id, { [String(field.id)]: next }); ledger.complete(op); }
    catch { ledger.fail(op, t(CELL_UNKNOWN)); }
    finally { refreshWrites(onMutate); }
  };
  if (!targetBase) return <span className="text-[12px] text-subtle">{t("未配置目标表")}</span>;
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
      {target.isError ? <span role="alert" className="text-[12px] text-destructive">{t("无法加载目标表，请重试。")}</span> : !targetReady ? <span role="status" className="text-[12px] text-subtle">{t("正在确认目标表访问权限…")}</span> : (targetData?.records ?? []).length === 0 && <span className="text-[12px] text-subtle">{t("目标表暂无记录")}</span>}
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
      <div className="mb-1.5 text-[12px] text-muted-foreground">{t("被以下记录关联")}</div>
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
  const { t } = useI18n();
  const q = useQuery({ queryKey: ["record-history", baseId, record.id, record.updatedAt], queryFn: () => baseApi.recordHistory(baseId, record.id) });
  const show = (f: Field, v: Cell | undefined) => {
    if (v === undefined || v === null) return t("空");
    // 人员/创建人历史值显示成员姓名，而不是裸用户 id。
    const text = REGISTRY[f.type].format(displayValue({ ...record, cells: { [f.id]: v } }, f, members), f, members);
    return text || t("空");
  };
  return (
    <div className="flex-1 overflow-y-auto px-10 py-4" data-record-history>
      {q.isPending ? <p className="text-[13px] text-subtle">{t("加载中…")}</p> : q.isError ? <p role="alert" className="text-[13px] text-destructive">{t("无法加载历史记录。")}</p> : q.data.length === 0 ? <p className="text-[13px] text-subtle">{t("暂无历史记录")}</p> : (
        <ol className="relative space-y-5 border-l border-[#dee0e3] pl-5">
          {q.data.map((e) => (
            <li key={e.seq} className="relative" data-history-entry={e.seq}>
              <span className="absolute -left-[25px] top-1.5 size-2 rounded-full bg-primary/70" />
              <div className="text-[13px]">
                {historyActorName(e, members) && (e.actor?.kind === "form"
                  ? <span className="mr-1.5 inline-grid size-5 place-items-center rounded-full bg-[#ffe4ba] align-middle text-[11px] text-[#d25f00]" data-history-avatar>{t("表")}</span>
                  : <span className="mr-1.5 inline-block align-middle" data-history-avatar><Avatar name={historyActorName(e, members)} color={colorFor((e.actor?.id ?? e.by ?? 1) - 1)} size={20} /></span>)}
                <span className="font-medium" data-history-headline>{historyHeadline(e, members)}</span>
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

/** 记录评论: threads (root + replies) with @人 and 解决/重新打开. */
function RecordComments({ baseId, recordId }: { baseId: number; recordId: number }) {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ["record-comments", baseId, recordId], queryFn: () => baseApi.recordComments(baseId, recordId) });
  const membersQ = useQuery({ queryKey: ["comment-members", baseId], queryFn: () => commentsApi.members(baseId), staleTime: 60_000 });
  const members = membersQ.data ?? [];
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
  const myId = me.data?.user.id;
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState("");
  const threads = threadComments(q.data?.comments ?? []);
  const reactionsOf = (cid: number) => q.data?.reactions[String(cid)] ?? [];
  const [picker, setPicker] = useState<number | null>(null);
  const react = async (cid: number, emoji: string, on: boolean) => {
    setError(""); setPicker(null);
    try { await baseApi.setRecordCommentReaction(baseId, recordId, cid, emoji, on); await q.refetch(); }
    catch { setError(t("表情回应未完成，请刷新后重试。")); }
  };
  const open = threads.filter((t) => !t.root.resolved);
  const resolved = threads.filter((t) => t.root.resolved);
  const post = async (body: string, parentId?: number) => {
    setError("");
    try { await baseApi.addRecordComment(baseId, recordId, body, { mentions: mentionsIn(body, members), parentId }); await q.refetch(); return true; }
    catch { setError(t("评论未能确认发送，请刷新后核对。")); return false; }
  };
  const toggle = async (cid: number, value: boolean) => {
    setError("");
    try { await baseApi.patchRecordComment(baseId, recordId, cid, { resolved: value }); await q.refetch(); }
    catch { setError(t("操作失败，请刷新后重试。")); }
  };
  const saveEdit = async (cid: number, body: string) => {
    setError("");
    try { await baseApi.patchRecordComment(baseId, recordId, cid, { body }); await q.refetch(); setEditing(null); return true; }
    catch { setError(t("评论修改未能确认，请刷新后核对。")); return false; }
  };
  const remove = async (c: Comment) => {
    if (!(await ask(t("删除这条评论？"), c.parentId ? t("删除后不可恢复。") : t("回复也会一并删除，删除后不可恢复。")))) return;
    setError("");
    try { await baseApi.deleteRecordComment(baseId, recordId, c.id); await q.refetch(); }
    catch { setError(t("操作失败，请刷新后重试。")); }
  };
  const names = (c: Comment) => (c.mentions ?? []).map((id) => members.find((m) => m.id === id)?.name ?? "").filter(Boolean);
  const item = (c: Comment, reply: boolean) => (
    <div key={c.id} className={cn("flex gap-2.5 text-[13px]", reply && "mt-2.5")} data-record-comment={c.id}>
      <Avatar name={c.userName} color={colorFor(c.userId - 1)} size={reply ? 22 : 26} />
      <div className="group/comment-body min-w-0 flex-1">
        <div className="group/comment flex items-center"><span className="font-medium">{c.userName}</span><span className="ml-2 text-[12px] text-subtle">{new Date(c.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
          {c.userId === myId && editing !== c.id && <span className={cn("ml-2 flex items-center gap-0.5 text-[12px] opacity-0 focus-within:opacity-100 group-hover/comment:opacity-100 [@media(hover:none)]:opacity-100", !reply && "mr-24")}>
            <button type="button" className="rounded px-1 text-muted-foreground hover:bg-hover hover:text-foreground" onClick={() => setEditing(c.id)} data-comment-edit>{t("编辑")}</button>
            <button type="button" className="rounded px-1 text-muted-foreground hover:bg-hover hover:text-destructive" onClick={() => void remove(c)} data-comment-delete>{t("删除")}</button>
          </span>}
        </div>
        {editing === c.id
          ? <div className="mt-1"><CommentComposer members={members} initial={c.body} autoFocus placeholder={t("编辑评论")} submitLabel={t("保存")} onSend={(b) => b === c.body ? (setEditing(null), Promise.resolve(true)) : saveEdit(c.id, b)} onCancel={() => setEditing(null)} /></div>
          : <p className="mt-0.5 whitespace-pre-wrap break-words">
          {splitMentions(c.body, names(c)).map((p, i) => p.mention ? <span key={i} className="rounded bg-accent px-0.5 font-medium text-primary" data-mention-chip>{p.text}</span> : <span key={i}>{p.text}</span>)}
        </p>}
        <div className="relative mt-1 flex flex-wrap items-center gap-1" data-comment-reactions={c.id}>
          {reactionsOf(c.id).map((r) => {
            const mine = myId !== undefined && r.userIds.includes(myId);
            const who = r.userIds.map((id) => members.find((m) => m.id === id)?.name ?? (id === myId ? me.data?.user.name : "")).filter(Boolean).join("、");
            return <button key={r.emoji} type="button" aria-pressed={mine} title={who} onClick={() => void react(c.id, r.emoji, !mine)} className={cn("flex h-6 items-center gap-1 rounded-full border px-2 text-[12px]", mine ? "border-primary/40 bg-[#e1eaff] text-primary" : "border-border bg-surface text-muted-foreground hover:bg-hover")} data-reaction={r.emoji}><span>{r.emoji}</span>{r.userIds.length}</button>;
          })}
          <button type="button" aria-label={t("添加表情回应")} aria-expanded={picker === c.id} onClick={() => setPicker(picker === c.id ? null : c.id)} className={cn("grid h-6 w-7 place-items-center rounded-full text-muted-foreground hover:bg-hover", picker !== c.id && !reactionsOf(c.id).length && "opacity-0 focus-visible:opacity-100 group-hover/comment-body:opacity-100 [@media(hover:none)]:opacity-100")} data-reaction-add><SmilePlus size={14} strokeWidth={1.7} /></button>
          {picker === c.id && <div role="menu" aria-label={t("选择表情")} className="absolute left-0 top-7 z-20 flex gap-0.5 rounded-lg border bg-surface p-1 shadow-[0_6px_24px_rgba(31,35,41,0.16)]" onKeyDown={(e) => { if (e.key === "Escape") setPicker(null); }}>
            {REACTION_EMOJIS.map((emoji) => { const mine = myId !== undefined && !!reactionsOf(c.id).find((r) => r.emoji === emoji)?.userIds.includes(myId); return <button key={emoji} type="button" role="menuitemcheckbox" aria-checked={mine} onClick={() => void react(c.id, emoji, !mine)} className={cn("grid size-8 place-items-center rounded-md text-[16px] hover:bg-hover", mine && "bg-[#e1eaff]")}>{emoji}</button>; })}
          </div>}
        </div>
      </div>
    </div>
  );
  const thread = (th: Thread) => (
    <div key={th.root.id} className={cn("group rounded-lg border px-3 py-2.5", th.root.resolved && "bg-[#f8f9fa]")} data-record-thread={th.root.id} data-resolved={th.root.resolved || undefined}>
      <div className="relative">
        {item(th.root, false)}
        <div className="absolute right-0 top-0 flex items-center gap-1 text-[12px]">
          {th.root.resolved && <span className="rounded bg-[#e1eaff] px-1.5 py-px text-[11px] font-medium text-primary">{t("已解决")}</span>}
          <button type="button" className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-hover hover:text-foreground" onClick={() => void toggle(th.root.id, !th.root.resolved)} data-thread-resolve>{th.root.resolved ? t("重新打开") : t("解决")}</button>
        </div>
      </div>
      {th.replies.length > 0 && <div className="ml-9 border-l pl-3">{th.replies.map((r) => item(r, true))}</div>}
      {!th.root.resolved && (replyTo === th.root.id
        ? <div className="ml-9 mt-2"><CommentComposer members={members} placeholder={t("回复 {name}", { name: th.root.userName })} autoFocus onSend={async (b) => { const ok = await post(b, th.root.id); if (ok) setReplyTo(null); return ok; }} onCancel={() => setReplyTo(null)} /></div>
        : <button type="button" className="ml-9 mt-1.5 text-[12px] text-muted-foreground hover:text-primary" onClick={() => setReplyTo(th.root.id)} data-thread-reply>{t("回复")}</button>)}
    </div>
  );
  return (
    <section className="border-t px-10 py-4" data-record-comments>
      <h3 className="mb-3 flex items-center gap-1.5 text-[14px] font-medium"><MessageSquare size={15} strokeWidth={1.7} />{t("评论")}{q.data?.comments.length ? <span className="text-subtle">{q.data.comments.length}</span> : null}
        {resolved.length > 0 && <button type="button" className="ml-auto text-[12px] font-normal text-muted-foreground hover:text-primary" onClick={() => setShowResolved((v) => !v)} data-show-resolved>{showResolved ? t("隐藏已解决") : t("显示已解决 {n}", { n: resolved.length })}</button>}
      </h3>
      <div className="space-y-2.5">
        {open.map(thread)}
        {showResolved && resolved.map(thread)}
        {q.isError && <p role="alert" className="text-[12px] text-destructive">{t("无法加载评论。")}</p>}
      </div>
      <div className="mt-3"><CommentComposer members={members} placeholder={t("输入评论，@ 提及成员，Enter 发送")} onSend={(b) => post(b)} /></div>
      {error && <p role="alert" className="mt-1 text-[12px] text-destructive">{error}</p>}
    </section>
  );
}

/** Textarea with an @ member picker; Enter sends, Shift+Enter breaks lines. */
function CommentComposer({ members, placeholder, autoFocus, onSend, onCancel, initial = "", submitLabel }: { members: User[]; placeholder: string; autoFocus?: boolean; onSend: (body: string) => Promise<boolean>; onCancel?: () => void; initial?: string; submitLabel?: string }) {
  const [body, setBody] = useState(initial);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mq = mentionQuery(body, caret);
  const matches = mq ? members.filter((m) => m.name.toLowerCase().includes(mq.query.toLowerCase())).slice(0, 6) : [];
  const pick = (m: User) => {
    if (!mq) return;
    const next = body.slice(0, mq.start) + "@" + m.name + " " + body.slice(caret);
    const pos = mq.start + m.name.length + 2;
    setBody(next); setCaret(pos); setActive(0);
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(pos, pos); });
  };
  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    if (await onSend(text)) { setBody(""); setCaret(0); }
    setSending(false);
  };
  return (
    <div className="relative">
      {matches.length > 0 && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-56 rounded-lg border bg-surface py-1 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.16)]" role="listbox" data-mention-picker>
          {matches.map((m, i) => (
            <button key={m.id} type="button" role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(m); }} className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover", i === active && "bg-hover")}>
              <Avatar name={m.name} color={colorFor(m.id - 1)} size={20} /><span className="truncate">{m.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-lg border bg-surface px-3 py-2 focus-within:border-primary">
        <textarea
          ref={ref}
          autoFocus={autoFocus}
          value={body}
          onChange={(e) => { setBody(e.target.value); setCaret(e.target.selectionStart); setActive(0); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setActive((a) => (a + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length); return; }
            if (matches.length && (e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) { e.preventDefault(); pick(matches[active] ?? matches[0]); return; }
            if (e.key === "Escape" && onCancel) { e.preventDefault(); onCancel(); return; }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
          }}
          rows={1}
          maxLength={2000}
          placeholder={placeholder}
          className="max-h-28 min-h-6 flex-1 resize-none bg-transparent text-[13px] outline-none"
          data-record-comment-input
        />
        {onCancel && <button type="button" onClick={onCancel} className="h-7 shrink-0 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-hover">{t("取消")}</button>}
        <button type="button" onClick={() => void send()} disabled={!body.trim() || sending} className="h-7 shrink-0 rounded-md bg-primary px-3 text-[12px] text-white disabled:opacity-40">{submitLabel ?? t("发送")}</button>
      </div>
    </div>
  );
}
