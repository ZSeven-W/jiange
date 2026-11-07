import { useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BaseRecord, DocMeta, Field, FieldType, View } from "@/lib/api";

export interface WriteAuthorization {
  base: DocMeta;
  fields: readonly Field[];
  records: readonly BaseRecord[];
  views: readonly View[];
  expansions: Record<string, unknown>;
  writeRestricted?: boolean;
}

export type IssueScope =
  | { kind: "view"; viewId: number }
  | { kind: "paste"; recordIds: number[]; fieldIds: number[] };

export interface WriteIssue {
  id: number;
  /** Scoped to the logical cell, so a later edit cannot race an unknown result. */
  key?: string;
  label: string;
  draft: string;
  status: "pending" | "failed";
  message?: string;
  /** Non-sensitive operation summary, e.g. source TSV coordinates only. */
  publicMessage?: string;
  /** Snapshot of the relevant authorized projection at the time of input. */
  authorization: string | null;
  authored: boolean;
  scope?: IssueScope;
}

/** These scalar editors capture the user's typed input, not relation data. */
export function isAuthoredCellType(type: FieldType) {
  return ["text", "number", "date", "url", "phone", "email"].includes(type);
}

/** A mismatch hides, but never deletes, the user's saved draft. */
function issueAuthorization(access: WriteAuthorization | null, key?: string, authored = false, scope?: IssueScope): string | null {
  if (!access || access.writeRestricted || !["edit", "manage"].includes(access.base.role ?? "") || (access.base.copyProtected && access.base.role !== "manage")) return null;
  try {
    const common = [access.base.id, access.base.role, !!access.base.copyProtected, !!access.writeRestricted];
    if (authored && scope?.kind === "view") {
      const view = access.views.find((item) => item.id === scope.viewId && item.baseId === access.base.id);
      return view ? JSON.stringify([common, view.id, view.type]) : null;
    }
    if (authored && scope?.kind === "paste") {
      const fieldsById = new Map(access.fields.map((item) => [item.id, item]));
      const recordsById = new Set(access.records.filter((item) => item.baseId === access.base.id).map((item) => item.id));
      const fields = scope.fieldIds.map((id) => fieldsById.get(id));
      if (fields.some((field) => !field) || scope.recordIds.some((id) => !recordsById.has(id))) return null;
      // The pasted text is supplied by the user. Values of ordinary cells may
      // change after a response is lost; relationship projections still need
      // to match so reduced target access cannot expose prior associations.
      const related = fields.filter((field) => field?.type === "link" || field?.type === "lookup").map((field) => [field!.id, access.expansions[String(field!.id)], access.expansions[`${field!.id}:titles`]]);
      return JSON.stringify([common, fields, scope.recordIds, related]);
    }
    const cell = /^cell:(\d+):(\d+)$/.exec(key ?? "");
    if (cell) {
      const record = access.records.find((item) => item.id === Number(cell[1]) && item.baseId === access.base.id);
      const field = access.fields.find((item) => item.id === Number(cell[2]));
      if (!record || !field) return null;
      const expansion = field.type === "link" || field.type === "lookup" ? [access.expansions[cell[2]], access.expansions[`${cell[2]}:titles`]] : undefined;
      // User-typed scalar input remains recoverable if the server committed
      // after its response was lost. Row and field must still be authorized.
      const value = authored && isAuthoredCellType(field.type) ? undefined : record.cells[cell[2]];
      return JSON.stringify([common, field, record.id, value, expansion]);
    }
    const recordKey = /^record:delete:(\d+)$/.exec(key ?? "");
    if (recordKey) {
      const record = access.records.find((item) => item.id === Number(recordKey[1]) && item.baseId === access.base.id);
      return record ? JSON.stringify([common, record]) : null;
    }
    const fieldKey = /^field:(?:delete|edit|order):(\d+)$/.exec(key ?? "");
    if (fieldKey) {
      const field = access.fields.find((item) => item.id === Number(fieldKey[1]));
      return field ? JSON.stringify([common, field]) : null;
    }
    // Batch and unscoped drafts can contain any cell or relation. Compare the
    // full authorized projection; large snapshots stay hidden rather than
    // weakening the check or exposing a partial scope.
    const value = JSON.stringify([common, access.fields, access.records, access.views, access.expansions]);
    return value.length <= 4_000_000 ? value : null;
  } catch { return null; }
}

/** Lives in the authenticated QueryClient, never in a process-wide account key. */
export class WriteLedger {
  private entries: WriteIssue[] = [];
  private listeners = new Set<() => void>();
  private next = 1;
  private authorization: WriteAuthorization | null = null;
  private lastAuthorization: WriteAuthorization | null = null;
  snapshot = () => this.entries;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(entries: WriteIssue[]) { this.entries = entries; for (const listener of this.listeners) listener(); }
  blocked(key: string) { return this.entries.some((entry) => entry.key === key); }
  hasCellWrites() { return this.entries.some((entry) => entry.key?.startsWith("cell:")); }
  setAuthorization(access: WriteAuthorization | null) {
    this.authorization = access;
    if (access) this.lastAuthorization = access;
  }
  mayShow(entry: WriteIssue) {
    return entry.authorization !== null && entry.authorization === issueAuthorization(this.authorization, entry.key, entry.authored, entry.scope);
  }
  capture(key?: string, authored = false, scope?: IssueScope) { return issueAuthorization(this.authorization, key, authored, scope); }
  begin(label: string, draft: string, key?: string, captured?: string | null, allowDuplicate = false, authored = false, scope?: IssueScope): number | null {
    if (key && !allowDuplicate && this.blocked(key)) return null;
    const id = this.next++;
    const stableScope = scope?.kind === "paste" ? { ...scope, recordIds: [...scope.recordIds], fieldIds: [...scope.fieldIds] } : scope;
    const authorization = captured === undefined ? issueAuthorization(this.authorization ?? this.lastAuthorization, key, authored, stableScope) : captured;
    this.publish([...this.entries, { id, label, draft, key, status: "pending", authorization, authored, scope: stableScope }]);
    return id;
  }
  complete(id: number) { this.publish(this.entries.filter((entry) => entry.id !== id)); }
  fail(id: number, message: string, publicMessage?: string) {
    this.publish(this.entries.map((entry) => entry.id === id ? { ...entry, status: "failed", message, publicMessage } : entry));
  }
  discard(id: number) { this.publish(this.entries.filter((entry) => entry.id !== id || entry.status === "pending")); }
  discardKey(key: string) { this.publish(this.entries.filter((entry) => entry.key !== key || entry.status === "pending")); }
}

const sessions = new WeakMap<object, Map<number, WriteLedger>>();
export function sessionWriteLedger(session: object, baseId: number): WriteLedger {
  let bases = sessions.get(session);
  if (!bases) { bases = new Map(); sessions.set(session, bases); }
  let ledger = bases.get(baseId);
  if (!ledger) { ledger = new WriteLedger(); bases.set(baseId, ledger); }
  return ledger;
}

export function useWriteLedger(baseId: number) {
  const client = useQueryClient();
  const ledger = sessionWriteLedger(client, baseId);
  const issues = useSyncExternalStore(ledger.subscribe, ledger.snapshot, ledger.snapshot);
  return { ledger, issues };
}

export const CELL_UNKNOWN = "无法确认是否保存。请刷新并核对当前值，再决定是否重新输入；不会自动重试。";
/** A batch operation stopped before issuing its next network request. */
export class WriteNotAttempted extends Error {}
/** Stops on the first uncertain write; later non-idempotent creates never run. */
export async function runWriteBatch(tasks: readonly (() => Promise<unknown>)[]): Promise<{ confirmed: number; attempted: number; total: number; complete: boolean }> {
  let confirmed = 0;
  for (const task of tasks) {
    try { await task(); confirmed++; }
    catch (error) { return { confirmed, attempted: confirmed + (error instanceof WriteNotAttempted ? 0 : 1), total: tasks.length, complete: false }; }
  }
  return { confirmed, attempted: confirmed, total: tasks.length, complete: true };
}

/** Query invalidation is best effort, including when a response was lost. */
export function refreshWrites(onMutate: () => void | Promise<unknown>) {
  void Promise.resolve().then(onMutate).catch(() => {});
}
export function cellDraft(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function WriteIssues({ ledger, issues }: { ledger: WriteLedger; issues: WriteIssue[] }) {
  if (!issues.length) return null;
  return <div className="space-y-2 border-b bg-[#fff8e8] px-3 py-2 text-[12px] text-[#815b00]" aria-label="未确认的表格修改">
    {issues.map((issue) => <div key={issue.id} role={issue.status === "failed" ? "alert" : "status"}>
      {ledger.mayShow(issue) ? <>
      <p>{issue.label}：{issue.status === "pending" ? "正在保存…" : issue.message}</p>
      {issue.status === "failed" && <>
        <label className="mt-1 block">原始输入（可复制）<textarea readOnly value={issue.draft} rows={Math.min(4, Math.max(1, issue.draft.split("\n").length))} className="mt-1 block w-full rounded border bg-surface px-2 py-1 text-foreground" /></label>
        <button type="button" onClick={() => ledger.discard(issue.id)} className="mt-1 underline">已核对，关闭提示</button>
      </>}
      </> : <><p>{issue.publicMessage ? `${issue.publicMessage} ` : ""}未确认的修改已保留；当前权限或数据范围发生变化，原内容暂时隐藏。</p>{issue.status === "failed" && <button type="button" onClick={() => ledger.discard(issue.id)} className="mt-1 underline">删除这条未确认草稿</button>}</>}
    </div>)}
    <p className="text-subtle">提示仅保存在当前登录会话内，刷新或退出后不会保留。</p>
  </div>;
}
