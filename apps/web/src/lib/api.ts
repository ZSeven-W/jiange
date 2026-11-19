import type { SlideShape, SlideLayout, SlideCreationLayout, SlidesPage } from "@jiange/slides-sdk";
export type { SlideShape, SlideLayout, SlideCreationLayout, SlidesPage } from "@jiange/slides-sdk";

export interface User {
  id: number;
  email: string;
  name: string;
  createdAt: string;
}
export interface Workspace {
  id: number;
  name: string;
  ownerId: number;
}
export interface Me {
  user: User;
  workspaces: Workspace[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? extraHeaders : { "Content-Type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText);
  return data as T;
}

/** Encode without spreading a potentially multi-megabyte batch into one call. */
export function conditionalBatchBase64(batch: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < batch.length; offset += 0x4000) binary += String.fromCharCode(...batch.subarray(offset, offset + 0x4000));
  return btoa(binary);
}

/** A retry must reuse the exact request ID, base version and operation bytes. */
export async function commitConditionalOps(input: { docId: number; userId: number; historyEpoch: number; expectedSeq: number; requestId: string; batch: Uint8Array; opCount: number; signal: AbortSignal }): Promise<number[]> {
  const { docId, userId, historyEpoch, expectedSeq, requestId, batch, opCount, signal } = input;
  if (![docId, userId, historyEpoch, expectedSeq, opCount].every(Number.isSafeInteger) || docId <= 0 || userId <= 0 || historyEpoch <= 0 || expectedSeq < 0 || opCount <= 0 || opCount > 100000 || expectedSeq + opCount > Number.MAX_SAFE_INTEGER || !/^[0-9a-f]{32}$/.test(requestId) || batch.length === 0 || batch.length > (8 << 20)) throw new ApiError(400, "invalid_request", "条件提交参数无效");
  const data = await request<{ sequences?: unknown }>("POST", `/api/docs/${docId}/conditional-ops`, { historyEpoch, expectedSeq, requestId, batch: conditionalBatchBase64(batch) }, signal, { "X-Jiange-User-Id": String(userId) });
  if (!Array.isArray(data?.sequences) || data.sequences.length !== opCount || data.sequences.some((seq, i) => !Number.isSafeInteger(seq) || seq !== expectedSeq + i + 1)) throw new ApiError(502, "invalid_receipt", "无法确认提交结果，请使用相同请求核对");
  return data.sequences as number[];
}

const verifiedConditionalStatus = Symbol("verified conditional status");
export type ConditionalOpsStatus = (
  | { state: "unknown"; docId: number; userId: number; requestId: string; currentEpoch: number; currentHead: number }
  | { state: "committed" | "history_changed"; docId: number; userId: number; requestId: string; currentEpoch: number; currentHead: number; historyEpoch: number; expectedSeq: number; firstSeq: number; opCount: number; digest: string }
  | { state: "cancelled"; docId: number; userId: number; requestId: string; currentEpoch: number; currentHead: number; historyEpoch: number; expectedSeq: number; firstSeq: number; opCount: number; clientId: number; digest: string }
) & { readonly [verifiedConditionalStatus]: true };

export function isVerifiedConditionalStatus(value: ConditionalOpsStatus): boolean { return value?.[verifiedConditionalStatus] === true; }
function verifiedStatus<T extends object>(value: T): T & { readonly [verifiedConditionalStatus]: true } {
  Object.defineProperty(value, verifiedConditionalStatus, { value: true });
  return Object.freeze(value) as T & { readonly [verifiedConditionalStatus]: true };
}

function parseConditionalStatus(value: unknown, docId: number, userId: number, requestId: string): ConditionalOpsStatus {
  const invalid = () => { throw new ApiError(502, "invalid_receipt", "无法确认提交结果，请稍后重试"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (result.docId !== docId || result.userId !== userId || result.requestId !== requestId || !Number.isSafeInteger(result.currentEpoch) || (result.currentEpoch as number) <= 0 || !Number.isSafeInteger(result.currentHead) || (result.currentHead as number) < 0) return invalid();
  const common = { docId, userId, requestId, currentEpoch: result.currentEpoch as number, currentHead: result.currentHead as number };
  if (result.state === "unknown") return verifiedStatus({ ...common, state: "unknown" as const });
  if (result.state !== "committed" && result.state !== "history_changed" && result.state !== "cancelled" || !Number.isSafeInteger(result.historyEpoch) || (result.historyEpoch as number) <= 0 || !Number.isSafeInteger(result.expectedSeq) || (result.expectedSeq as number) < 0 || !Number.isSafeInteger(result.firstSeq) || result.firstSeq !== (result.expectedSeq as number) + 1 || !Number.isSafeInteger(result.opCount) || (result.opCount as number) <= 0 || (result.opCount as number) > 100000 || (result.expectedSeq as number) + (result.opCount as number) > Number.MAX_SAFE_INTEGER || typeof result.digest !== "string" || !/^[0-9a-f]{64}$/.test(result.digest)) return invalid();
  if (result.state === "committed" && (common.currentEpoch !== result.historyEpoch || common.currentHead < (result.expectedSeq as number) + (result.opCount as number)) || result.state === "history_changed" && common.currentEpoch === result.historyEpoch || result.state === "cancelled" && (common.currentEpoch !== result.historyEpoch || !Number.isSafeInteger(result.clientId) || (result.clientId as number) <= 0)) return invalid();
  if (result.state === "cancelled") return verifiedStatus({ ...common, state: "cancelled" as const, historyEpoch: result.historyEpoch as number, expectedSeq: result.expectedSeq as number, firstSeq: result.firstSeq as number, opCount: result.opCount as number, clientId: result.clientId as number, digest: result.digest });
  return verifiedStatus({ ...common, state: result.state, historyEpoch: result.historyEpoch as number, expectedSeq: result.expectedSeq as number, firstSeq: result.firstSeq as number, opCount: result.opCount as number, digest: result.digest });
}

/** "unknown" is not a rejection: an earlier submission may still be in flight. */
export async function queryConditionalOpsStatus(input: { docId: number; userId: number; requestId: string; signal: AbortSignal }): Promise<ConditionalOpsStatus> {
  const { docId, userId, requestId, signal } = input;
  if (![docId, userId].every(Number.isSafeInteger) || docId <= 0 || userId <= 0 || !/^[0-9a-f]{32}$/.test(requestId)) throw new ApiError(400, "invalid_request", "条件提交查询参数无效");
  const response = await fetch(`/api/docs/${docId}/conditional-ops/${requestId}`, { credentials: "same-origin", cache: "no-store", headers: { "X-Jiange-User-Id": String(userId) }, signal });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) { const error = value as { error?: string; message?: string } | null; throw new ApiError(response.status, error?.error ?? "error", error?.message ?? response.statusText); }
  return parseConditionalStatus(value, docId, userId, requestId);
}

/** Fence an uncertain request without sending its potentially restricted content. */
export async function cancelConditionalOps(input: { docId: number; userId: number; requestId: string; historyEpoch: number; expectedSeq: number; opCount: number; clientId: number; digest: string; signal: AbortSignal }): Promise<ConditionalOpsStatus> {
  const { docId, userId, requestId, historyEpoch, expectedSeq, opCount, clientId, digest, signal } = input;
  if (![docId, userId, historyEpoch, expectedSeq, opCount, clientId].every(Number.isSafeInteger) || docId <= 0 || userId <= 0 || historyEpoch <= 0 || expectedSeq < 0 || opCount <= 0 || opCount > 100000 || expectedSeq + opCount > Number.MAX_SAFE_INTEGER || clientId <= 0 || !/^[0-9a-f]{32}$/.test(requestId) || !/^[0-9a-f]{64}$/.test(digest)) throw new ApiError(400, "invalid_request", "条件提交停止参数无效");
  const response = await fetch(`/api/docs/${docId}/conditional-ops/${requestId}/cancel`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-Jiange-User-Id": String(userId) }, body: JSON.stringify({ historyEpoch, expectedSeq, opCount, clientId, digest }), signal });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) { const error = value as { error?: string; message?: string } | null; throw new ApiError(response.status, error?.error ?? "error", error?.message ?? response.statusText); }
  const status = parseConditionalStatus(value, docId, userId, requestId);
  if ((status.state !== "committed" && status.state !== "cancelled") || status.historyEpoch !== historyEpoch || status.expectedSeq !== expectedSeq || status.opCount !== opCount || status.digest !== digest || status.state === "cancelled" && status.clientId !== clientId) throw new ApiError(502, "invalid_receipt", "无法确认停止结果，请稍后重试");
  return status;
}

export const api = {
  me: () => request<Me>("GET", "/api/me"),
  login: (email: string, password: string) => request<Me>("POST", "/api/auth/login", { email, password }),
  register: (email: string, name: string, password: string) => request<Me>("POST", "/api/auth/register", { email, name, password }),
  logout: () => request<void>("POST", "/api/auth/logout"),
};

export interface DocMeta {
  id: number;
  workspaceId: number;
  parentId: number | null;
  title: string;
  icon: string;
  creatorId: number;
  creatorName: string;
  createdAt: string;
  updatedAt: string;
  role?: Role;
  kind?: "doc" | "base" | "folder" | "slides" | "file" | "sheet" | "survey";
  docType?: string;
  workspaceName?: string;
  copyProtected?: boolean;
  copyMinRole?: Role;
  downloadMinRole?: Role;
  /** Missing on older servers, which only permit editors to comment. */
  commentMinRole?: "view" | "edit";
  permissionsRevision?: number;
  inheritParentAcl?: boolean;
  /** Versioned-drive optimistic concurrency (move/trash/restore); 0 on nodes never touched by the drive API. */
  driveRevision?: number;
  /** Groups the subtree of one guarded trash operation; 0 for legacy deletions. */
  trashBatchId?: number;
  wikiSpaceId?: number | null;
  wikiSpaceName?: string;
}
export interface ReferenceVisibility { visible: boolean; revision: number }
function checkedReferenceVisibility(value: unknown): ReferenceVisibility {
  if (!value || typeof value !== "object") throw new TypeError("无法确认显示设置");
  const setting = value as Partial<ReferenceVisibility>;
  if (typeof setting.visible !== "boolean" || !Number.isSafeInteger(setting.revision) || setting.revision! < 0) throw new TypeError("无法确认显示设置");
  return setting as ReferenceVisibility;
}
/** A document returned by the per-user recent-visit history. */
export interface RecentDoc extends DocMeta {
  viewedAt: string;
}
export type FieldType =
  | "text"
  | "number"
  | "select"
  | "checkbox"
  | "date"
  | "multi_select"
  | "person"
  | "attachment"
  | "created_by"
  | "created_at"
  | "modified_at"
  | "url"
  | "phone"
  | "email"
  | "rating"
  | "formula"
  | "link"
  | "lookup";
export interface BaseTable {
  id: number;
  baseId: number;
  name: string;
  position: number;
  isDefault: boolean;
}
export interface Field {
  id: number;
  tableId?: number;
  targetTableId?: number;
  name: string;
  type: FieldType;
  /** Stable record-title field; it is not inferred from visible column order. */
  isPrimary?: boolean;
  description?: string;
  options?: string[];
  /** preset palette index per option (-1/absent = auto) */
  optionColors?: number[];
  /** expression for type=formula (see base/formula.ts) */
  formula?: string;
  position: number;
  /** 允许多选: person fields store an array of member ids when true. */
  multiple?: boolean;
  /** 默认值: applied by the server to omitted cells of new records; null clears. */
  defaultValue?: Cell | null;
}
export interface AttachmentRef {
  id: number;
  name: string;
  mime: string;
  size: number;
}
export type Cell = string | number | boolean | string[] | number[] | AttachmentRef[];
export interface BaseRecord {
  id: number;
  baseId: number;
  tableId?: number;
  cells: Record<string, Cell>;
  position: number;
  creatorId?: number;
  createdAt?: string;
  updatedAt?: string;
}
export interface FilterRule {
  f: number;
  op: string;
  /** person contains/not_contains carry an array of member ids */
  v?: string | number | boolean | number[];
}
export interface RecordHistoryEntry {
  seq: number;
  op: "add" | "update";
  at?: string;
  by?: number;
  /** Who made it; absent on events written before actors were recorded. */
  actor?: { kind: "user" | "form"; id?: number; name?: string };
  changes: { f: number; before?: Cell; after?: Cell }[];
}
export interface ViewConfig {
  /** Form-specific fields. An explicit selection is required before sharing. */
  title?: string;
  desc?: string;
  fields?: number[];
  required?: number[];
  filters?: { conj: "and" | "or"; rules: FilterRule[] };
  sorts?: { f: number; asc: boolean }[];
  group?: number;
  hidden?: number[];
  /** 管理视图：filters 强制生效、hidden 字段对非 manage 角色剔除/写保护 */
  locked?: boolean;
  /** 锁定视图配置（飞书语义）：仅管理员可修改视图筛选/排序/隐藏配置，不影响正常读写数据 */
  configLocked?: boolean;
  /** Grid row height preset (Feishu 行高). */
  rowHeight?: RowHeight;
  /** Conditional row fill (Feishu 填色); first matching rule wins. Evaluated client-side on visible data. */
  fills?: FillRule[];
  /** Number of leading visible grid fields kept frozen while scrolling horizontally (default 1 = primary). */
  frozen?: number;
  /** Kanban/gallery card presentation (Feishu 卡片配置). */
  card?: { fields?: number[]; cover?: number | null };
}
export type RowHeight = "low" | "medium" | "high" | "xhigh";
export interface FillRule extends FilterRule {
  /** palette index (see PALETTE) */
  color: number;
}
export interface View {
  id: number;
  baseId: number;
  tableId?: number;
  ownerId?: number;
  type: "grid" | "kanban" | "gallery" | "calendar" | "form" | "gantt";
  name: string;
  config: ViewConfig;
  pos: number;
}
type BaseSnapshot = { base: DocMeta; tables?: BaseTable[]; activeTableId?: number; fields: Field[]; records: BaseRecord[]; head: number; members: User[]; views: View[]; expansions?: Record<string, unknown>; writeRestricted?: boolean };
export const baseApi = {
  create: (title?: string, parentId: number | null = null) => request<DocMeta>("POST", "/api/bases", { title, parentId }),
  get: (id: number, signal?: AbortSignal, tableId?: number | null) =>
    request<BaseSnapshot>(
      "GET",
      tableId ? `/api/bases/${id}?tableId=${tableId}` : `/api/bases/${id}`,
      undefined,
      signal,
    ),
  getForAccount: (id: number, userId: number, signal?: AbortSignal, tableId?: number | null) =>
    request<BaseSnapshot>(
      "GET",
      tableId ? `/api/bases/${id}/account-snapshot?tableId=${tableId}` : `/api/bases/${id}/account-snapshot`,
      undefined,
      signal,
      { "X-Jiange-User-Id": String(userId) },
    ),
  listTables: (id: number) => request<{ tables: BaseTable[] }>("GET", `/api/bases/${id}/tables`).then((r) => r.tables),
  createTable: (id: number, name: string) => request<BaseTable>("POST", `/api/bases/${id}/tables`, { name }),
  renameTable: (id: number, tid: number, name: string) => request<BaseTable>("PATCH", `/api/bases/${id}/tables/${tid}`, { name }),
  deleteTable: (id: number, tid: number) => request<void>("DELETE", `/api/bases/${id}/tables/${tid}`),
  reorderTables: (id: number, ids: number[]) => request<{ tables: BaseTable[] }>("POST", `/api/bases/${id}/tables/reorder`, { ids }).then((r) => r.tables),
  /** 双向关联：反向引用列表 */
  reverse: (id: number) =>
    request<{ expansions?: { reverse?: { sourceBase: number; fieldId: number; from: Record<string, number[]>; titles: Record<string, string> }[] } }>("GET", `/api/bases/${id}`).then((r) => r.expansions?.reverse ?? []),
  /** 记录历史：字段级变更（新→旧），按当前读者的权限视图过滤 */
  recordHistory: (id: number, rid: number) => request<{ entries: RecordHistoryEntry[] }>("GET", `/api/bases/${id}/records/${rid}/history`).then((r) => r.entries),
  recordComments: (id: number, rid: number) => request<{ comments: Comment[]; reactions?: Record<string, CommentReaction[]> }>("GET", `/api/bases/${id}/records/${rid}/comments`).then((r) => ({ comments: r.comments, reactions: r.reactions ?? {} })),
  /** 评论表情回应：on=true 添加、false 取消（固定表情集合）。 */
  setRecordCommentReaction: (id: number, rid: number, cid: number, emoji: string, on: boolean) => request<void>("POST", `/api/bases/${id}/records/${rid}/comments/${cid}/reactions`, { emoji, on }),
  addRecordComment: (id: number, rid: number, body: string, opts: { mentions?: number[]; parentId?: number } = {}) => request<Comment>("POST", `/api/bases/${id}/records/${rid}/comments`, { body, ...opts }),
  patchRecordComment: (id: number, rid: number, cid: number, p: { body?: string; resolved?: boolean }) => request<Comment | undefined>("PATCH", `/api/bases/${id}/records/${rid}/comments/${cid}`, p),
  deleteRecordComment: (id: number, rid: number, cid: number) => request<void>("DELETE", `/api/bases/${id}/records/${rid}/comments/${cid}`),
  addField: (id: number, f: Partial<Field>) => request<Field>("POST", `/api/bases/${id}/fields`, f),
  patchField: (id: number, fid: number, f: Partial<Field>) => request<Field>("PATCH", `/api/bases/${id}/fields/${fid}`, f),
  reorderFields: (id: number, expectedFieldIds: number[], desiredFieldIds: number[]) => request<void>("POST", `/api/bases/${id}/fields/reorder`, { expectedFieldIds, desiredFieldIds }),
  deleteField: (id: number, fid: number) => request<void>("DELETE", `/api/bases/${id}/fields/${fid}`),
  addRecord: (id: number, cells: Record<string, Cell> = {}, tableId?: number | null) =>
    request<BaseRecord>("POST", `/api/bases/${id}/records`, tableId ? { cells, tableId } : { cells }),
  setCells: (id: number, rid: number, cells: Record<string, Cell | number[] | null>) => request<BaseRecord>("PATCH", `/api/bases/${id}/records/${rid}`, { cells }),
  compareCells: (id: number, rid: number, expected: Record<string, Cell | null>, cells: Record<string, Cell | null>) =>
    request<BaseRecord>("PATCH", `/api/bases/${id}/records/${rid}/compare-cells`, { expected, cells }),
  moveRecord: (id: number, rid: number, position: number) => request<BaseRecord>("PATCH", `/api/bases/${id}/records/${rid}`, { move: true, position }),
  deleteRecord: (id: number, rid: number) => request<void>("DELETE", `/api/bases/${id}/records/${rid}`),
  /** Undo/redo: write only while `expected` cells still hold these values (409 cells_changed otherwise). */
  setCellsIf: (id: number, rid: number, expected: Record<string, Cell | number[] | null>, cells: Record<string, Cell | number[] | null>) =>
    request<BaseRecord>("PATCH", `/api/bases/${id}/records/${rid}`, { cells, expected }),
  /** Undo of a created record: delete only while it holds exactly `expected`. */
  deleteRecordIf: (id: number, rid: number, expected: Record<string, Cell | number[] | null>) => request<void>("DELETE", `/api/bases/${id}/records/${rid}`, { expected, exact: true }),
  automations: (id: number) => request<{ automations: Automation[] }>("GET", `/api/bases/${id}/automations`).then((r) => r.automations),
  addAutomation: (id: number, a: Partial<Automation>) => request<Automation>("POST", `/api/bases/${id}/automations`, a),
  updateAutomation: (id: number, aid: number, a: Partial<Automation>) => request<Automation>("PATCH", `/api/bases/${id}/automations/${aid}`, a),
  deleteAutomation: (id: number, aid: number) => request<void>("DELETE", `/api/bases/${id}/automations/${aid}`),
  addView: (id: number, v: Partial<View> & { isPersonal?: boolean }) => request<View>("POST", `/api/bases/${id}/views`, v),
  addViewForAccount: (id: number, userId: number, v: Partial<View> & { isPersonal?: boolean }) => request<View>("POST", `/api/bases/${id}/account-views`, v, undefined, { "X-Jiange-User-Id": String(userId) }),
  patchView: (id: number, vid: number, v: Partial<View>) => request<View>("PATCH", `/api/bases/${id}/views/${vid}`, v),
  renameView: (id: number, vid: number, expectedName: string, name: string) => request<View>("POST", `/api/bases/${id}/views/${vid}/rename`, { expectedName, name }),
  duplicateView: (id: number, vid: number) => request<View>("POST", `/api/bases/${id}/views/${vid}/duplicate`, {}),
  reorderViews: (id: number, expectedViewIds: number[], viewIds: number[]) => request<{ views: View[] }>("POST", `/api/bases/${id}/views/reorder`, { expectedViewIds, viewIds }),
  deleteView: (id: number, vid: number) => request<void>("DELETE", `/api/bases/${id}/views/${vid}`),
  query: (id: number, q: { tableId?: number; filters?: ViewConfig["filters"]; sorts?: ViewConfig["sorts"]; limit?: number }, signal?: AbortSignal) =>
    request<{ records: BaseRecord[] }>("POST", `/api/bases/${id}/query`, q, signal),
  importCSV: (id: number, csv: string, header = true, types?: string[]) =>
    request<{ imported: number; fields: number; errors: { row: number; err: string }[] }>("POST", `/api/bases/${id}/import`, { csv, header, types }),
  importRecordsForAccount: (id: number, userId: number, fields: Pick<Field, "id" | "name" | "type" | "options">[], rows: Record<string, Cell>[]) =>
    request<{ imported: number }>("POST", `/api/bases/${id}/import-records`, { fields, rows }, undefined, { "X-Jiange-User-Id": String(userId) }),
};
export interface UserTemplate { id: number; name: string; body: string; createdAt: string }
/** 我的模板（仅本人可见）。 */
export const templatesApi = {
  list: () => request<{ templates: UserTemplate[] }>("GET", "/api/me/templates").then((r) => r.templates),
  add: (name: string, body: string) => request<UserTemplate>("POST", "/api/me/templates", { name, body }),
  remove: (id: number) => request<void>("DELETE", `/api/me/templates/${id}`),
};
export interface CommentReaction { emoji: string; userIds: number[] }
/** 与服务端 store.ReactionEmojis 一致的固定表情集合。 */
export const REACTION_EMOJIS = ["👍", "✅", "😄", "❤️", "🎉", "👀", "🙏", "💪"] as const;
export interface Comment {
  id: number;
  docId: number;
  userId: number;
  userName: string;
  parentId?: number;
  block: string;
  startChar: string;
  endChar: string;
  quote: string;
  body: string;
  mentions?: number[];
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AppNotification {
  id: number;
  userId: number;
  docId: number;
  docTitle?: string;
  actorId: number;
  actorName?: string;
  commentId?: number;
  kind: "mention" | "reply" | "resolve";
  read: boolean;
  createdAt: string;
  preview?: string;
  anchorBlock?: string;
  anchorChar?: string;
  anchorEpoch?: number;
}
export type LinkPreview = { url: string; title: string; description?: string; icon?: string; siteName?: string };
export const linkApi = {
  preview: (url: string, signal?: AbortSignal) => request<LinkPreview>("GET", `/api/link-preview?url=${encodeURIComponent(url)}`, undefined, signal),
};

export const commentsApi = {
  list: (id: number) => request<{ comments: Comment[] }>("GET", `/api/docs/${id}/comments`).then((r) => r.comments),
  create: (id: number, c: Partial<Comment> & { body: string }) => request<Comment | undefined>("POST", `/api/docs/${id}/comments`, c).then((result) => {
    // A 204 explicitly confirms the write but carries no body when access
    // changed after commit. Invalidation will recheck access before display.
    if (result === undefined) return undefined;
    // A successful HTTP status with a truncated or malformed body does not
    // prove which comment was created. Preserve the draft and let the user
    // inspect a refreshed list rather than silently treating it as submitted.
    if (!result || !Number.isSafeInteger(result.id) || result.id < 1 || result.docId !== id || result.body !== c.body || (result.parentId ?? null) !== (c.parentId ?? null)) {
      throw new Error("评论响应不完整，结果未确认");
    }
    return result;
  }),
  update: (id: number, cid: number, p: { body?: string; resolved?: boolean }) => request<Comment | undefined>("PATCH", `/api/docs/${id}/comments/${cid}`, p),
  updateForAccount: (id: number, cid: number, userId: number, p: { resolved: boolean }) => request<Comment | undefined>("PATCH", `/api/docs/${id}/account-comments/${cid}`, p, undefined, { "X-Jiange-User-Id": String(userId) }),
  remove: (id: number, cid: number) => request<void>("DELETE", `/api/docs/${id}/comments/${cid}`),
  members: (id: number) => request<{ members: User[] }>("GET", `/api/docs/${id}/members`).then((r) => r.members),
};

export interface DocSuggestion {
  id: number;
  docId: number;
  blockId: string;
  authorId: number;
  authorName: string;
  kind: "replace" | "insert" | "delete";
  originalText: string;
  proposedText: string;
  note: string;
  status: "open" | "accepted" | "rejected" | "withdrawn";
  resolvedBy?: number;
  resolvedByName?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const suggestionsApi = {
  list: (id: number, status: "open" | "resolved" | "all" = "all") =>
    request<{ suggestions: DocSuggestion[] }>("GET", `/api/docs/${id}/suggestions?status=${status}`).then((r) => r.suggestions),
  create: (id: number, body: { blockId: string; kind?: "replace" | "insert" | "delete"; originalText: string; proposedText: string; note?: string }) =>
    request<DocSuggestion>("POST", `/api/docs/${id}/suggestions`, body),
  updateNote: (id: number, sid: number, note: string) =>
    request<DocSuggestion>("PATCH", `/api/docs/${id}/suggestions/${sid}`, { note }),
  accept: (id: number, sid: number) =>
    request<DocSuggestion>("POST", `/api/docs/${id}/suggestions/${sid}/accept`),
  reject: (id: number, sid: number) =>
    request<DocSuggestion>("POST", `/api/docs/${id}/suggestions/${sid}/reject`),
  withdraw: (id: number, sid: number) =>
    request<DocSuggestion>("POST", `/api/docs/${id}/suggestions/${sid}/withdraw`),
  acceptAll: (id: number) =>
    request<{ suggestions: DocSuggestion[] }>("POST", `/api/docs/${id}/suggestions/accept-all`).then((r) => r.suggestions),
  rejectAll: (id: number) =>
    request<{ suggestions: DocSuggestion[] }>("POST", `/api/docs/${id}/suggestions/reject-all`).then((r) => r.suggestions),
};

export interface SyncedBlock {
  id: string;
  workspaceId: number;
  sourceDocId: number;
  sourceDocTitle?: string;
  content: string;
  revision: number;
  updatedBy?: number;
  updatedByName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncedBlockResponse {
  syncedBlock: SyncedBlock;
  canEdit: boolean;
}

export interface DocSubpage {
  id: number;
  title: string;
  kind: string;
  docType?: string;
  icon?: string;
  updatedAt: string;
}

export const syncedBlocksApi = {
  create: (docId: number, content = "") =>
    request<SyncedBlockResponse>("POST", `/api/docs/${docId}/synced-blocks`, { content }),
  get: (sid: string) =>
    request<SyncedBlockResponse>("GET", `/api/synced-blocks/${encodeURIComponent(sid)}`),
  update: (sid: string, content: string, expectedRevision = 0) =>
    request<SyncedBlockResponse>("PUT", `/api/synced-blocks/${encodeURIComponent(sid)}`, { content, expectedRevision }),
};

export const subpagesApi = {
  list: (docId: number) =>
    request<{ subpages: DocSubpage[] }>("GET", `/api/docs/${docId}/subpages`).then((r) => r.subpages),
};

export interface SurveySkipRule {
  whenOption: string;
  jumpToQuestionId: string;
}

export type SurveyQuestionType = "single" | "multi" | "text" | "rating" | "matrix" | "ranking" | "signature" | "file";

export interface SurveyQuestion {
  id: string;
  type: SurveyQuestionType;
  title: string;
  description?: string;
  required: boolean;
  options?: string[];
  matrixRows?: string[];
  matrixCols?: string[];
  maxRating?: number;
  skipRules?: SurveySkipRule[];
}

export interface Survey {
  nodeId: number;
  description: string;
  status: "draft" | "published" | "closed";
  publicToken?: string;
  allowAnonymous: boolean;
  maxResponses: number;
  questions: SurveyQuestion[];
  revision: number;
  publishedAt?: string;
  closedAt?: string;
  updatedAt: string;
}

export interface SurveyDetailResponse {
  survey: Survey;
  title: string;
  role: Role;
  responseCount: number;
}

export interface SurveyResponseRecord {
  id: number;
  surveyId: number;
  respondentId?: number;
  respondentName: string;
  answers: Record<string, unknown>;
  submittedAt: string;
}

export interface SurveyQuestionStat {
  questionId: string;
  title: string;
  type: SurveyQuestionType;
  answered: number;
  optionCounts?: Record<string, number>;
  average?: number;
  ratingDist?: Record<string, number>;
  matrixCounts?: Record<string, Record<string, number>>;
  rankAvg?: Record<string, number>;
  textSamples?: string[];
}

export interface SurveyStatsResponse {
  totalResponses: number;
  questionStats: SurveyQuestionStat[];
  responses: SurveyResponseRecord[];
}

export interface PublicSurveyPayload {
  title: string;
  description: string;
  allowAnonymous: boolean;
  maxResponses: number;
  responseCount: number;
  full: boolean;
  questions: SurveyQuestion[];
}

export const surveysApi = {
  get: (id: number) => request<SurveyDetailResponse>("GET", `/api/surveys/${id}`),
  save: (id: number, body: { description: string; questions: SurveyQuestion[]; allowAnonymous?: boolean; maxResponses?: number; expectedRevision?: number }) =>
    request<{ survey: Survey }>("PUT", `/api/surveys/${id}`, body).then((r) => r.survey),
  setStatus: (id: number, body: { status: "draft" | "published" | "closed"; allowAnonymous?: boolean; maxResponses?: number }) =>
    request<{ survey: Survey }>("POST", `/api/surveys/${id}/status`, body).then((r) => r.survey),
  stats: (id: number) => request<SurveyStatsResponse>("GET", `/api/surveys/${id}/stats`),
  getPublic: (token: string) => request<PublicSurveyPayload>("GET", `/api/public/surveys/${encodeURIComponent(token)}`),
  submitPublic: (token: string, body: { respondentName?: string; answers: Record<string, unknown> }) =>
    request<{ response: SurveyResponseRecord }>("POST", `/api/public/surveys/${encodeURIComponent(token)}/submit`, body),
};
export const notificationsApi = {
  list: () => request<{ notifications: AppNotification[]; unread: number }>("GET", "/api/notifications"),
  markRead: (ids: number[] = []) => request<void>("POST", "/api/notifications/read", { ids }),
};
export interface Version {
  seq: number;
  label: string;
  createdBy: number;
  createdByName: string;
  createdAt: string;
}
export interface VersionEntry extends Version { id: string; revision: number }
export interface DeletedVersionEntry extends VersionEntry { deletedAt: string }
export interface DocView {
  blocks: { id: string; parent: string; type: string; props: Record<string, string>; spans: { text: string; marks: Record<string, string> }[] }[];
}
export type Role = "view" | "edit" | "manage";
export interface Share {
  userId: number;
  name: string;
  email: string;
  role: Role;
}
export interface SubjectShare {
  subjectType: "department" | "group";
  subjectId: number;
  name: string;
  memberCount: number;
  role: Role;
}
export interface ShareInfo {
  members: Share[];
  subjects?: SubjectShare[];
  link: { role: "none" | "anon" | "view" | "edit" | "workspace_view" | "workspace_edit"; token?: string; revision?: number };
  role: Role;
  inheritParentAcl?: boolean;
  workspaceId?: number;
}
export type WorkspaceRole = "owner" | "admin" | "member";
export interface WorkspaceMemberInfo {
  userId: number;
  email: string;
  name: string;
  role: WorkspaceRole;
  createdAt: string;
}
export interface OrgDepartmentMember {
  userId: number;
  name: string;
  email: string;
  isLeader: boolean;
}
export interface OrgDepartment {
  id: number;
  workspaceId: number;
  parentId: number | null;
  name: string;
  sortOrder: number;
  members: OrgDepartmentMember[];
  createdAt: string;
  updatedAt: string;
}
export interface OrgGroupMember {
  userId: number;
  name: string;
  email: string;
}
export interface OrgGroup {
  id: number;
  workspaceId: number;
  name: string;
  description: string;
  members: OrgGroupMember[];
  createdAt: string;
  updatedAt: string;
}
export interface WorkspaceOrgSnapshot {
  workspaceId: number;
  workspaceName: string;
  callerRole: WorkspaceRole;
  members: WorkspaceMemberInfo[];
  departments: OrgDepartment[];
  groups: OrgGroup[];
  /** Pending invitations; empty unless the caller is an owner/admin. */
  invitations?: WorkspaceInvitation[];
}
export interface WorkspaceInvitation {
  id: number;
  workspaceId: number;
  workspaceName?: string;
  email: string;
  role: "member" | "admin";
  inviterName?: string;
  createdAt: string;
}
/** A non-member email always yields "invited", whether or not it is registered. */
export interface WorkspaceMemberChange {
  status: "updated" | "invited" | "removed";
  member?: WorkspaceMemberInfo;
  invitation?: WorkspaceInvitation;
}
export const invitationsApi = {
  mine: (userId: number) =>
    request<{ invitations: WorkspaceInvitation[] }>("GET", "/api/invitations", undefined, undefined, { "X-Jiange-User-Id": String(userId) }).then((r) => r.invitations ?? []),
  respond: (invitationId: number, userId: number, accept: boolean) =>
    request<void>("POST", `/api/invitations/${invitationId}/${accept ? "accept" : "decline"}`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
};
export const orgApi = {
  get: (wsId: number, userId: number) =>
    request<WorkspaceOrgSnapshot>("GET", `/api/workspaces/${wsId}/org`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
  upsertMember: (wsId: number, userId: number, email: string, role: "member" | "admin" | "remove") =>
    request<WorkspaceMemberChange>("POST", `/api/workspaces/${wsId}/members`, { email, role }, undefined, { "X-Jiange-User-Id": String(userId) }),
  revokeInvitation: (wsId: number, invitationId: number, userId: number) =>
    request<void>("DELETE", `/api/workspaces/${wsId}/invitations/${invitationId}`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
  createDepartment: (wsId: number, userId: number, name: string, parentId: number | null = null, sortOrder = 0) =>
    request<OrgDepartment>("POST", `/api/workspaces/${wsId}/departments`, { name, parentId, sortOrder }, undefined, { "X-Jiange-User-Id": String(userId) }),
  updateDepartment: (wsId: number, deptId: number, userId: number, patch: { name?: string; parentId?: number | null; sortOrder?: number }) =>
    request<OrgDepartment>("PATCH", `/api/workspaces/${wsId}/departments/${deptId}`, patch, undefined, { "X-Jiange-User-Id": String(userId) }),
  deleteDepartment: (wsId: number, deptId: number, userId: number) =>
    request<void>("DELETE", `/api/workspaces/${wsId}/departments/${deptId}`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
  setDepartmentMember: (wsId: number, deptId: number, userId: number, memberUserId: number, present: boolean, isLeader = false) =>
    request<void>("PUT", `/api/workspaces/${wsId}/departments/${deptId}/members`, { userId: memberUserId, present, isLeader }, undefined, { "X-Jiange-User-Id": String(userId) }),
  createGroup: (wsId: number, userId: number, name: string, description = "") =>
    request<OrgGroup>("POST", `/api/workspaces/${wsId}/groups`, { name, description }, undefined, { "X-Jiange-User-Id": String(userId) }),
  updateGroup: (wsId: number, groupId: number, userId: number, patch: { name?: string; description?: string }) =>
    request<OrgGroup>("PATCH", `/api/workspaces/${wsId}/groups/${groupId}`, patch, undefined, { "X-Jiange-User-Id": String(userId) }),
  deleteGroup: (wsId: number, groupId: number, userId: number) =>
    request<void>("DELETE", `/api/workspaces/${wsId}/groups/${groupId}`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
  setGroupMember: (wsId: number, groupId: number, userId: number, memberUserId: number, present: boolean) =>
    request<void>("PUT", `/api/workspaces/${wsId}/groups/${groupId}/members`, { userId: memberUserId, present }, undefined, { "X-Jiange-User-Id": String(userId) }),
};

export type WikiVisibility = "workspace" | "private";
export type WikiGrantSubjectType = "user" | "department" | "group";
export type WikiNodeKind = "doc" | "sheet" | "base" | "slides" | "survey" | "folder";

export interface WikiSpace {
  id: number;
  workspaceId: number;
  name: string;
  description: string;
  icon: string;
  visibility: WikiVisibility;
  creatorId: number;
  creatorName: string;
  callerRole: Role;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface WikiSpaceGrant {
  subjectType: WikiGrantSubjectType;
  subjectId: number;
  name: string;
  email?: string;
  memberCount?: number;
  role: Role;
}
export interface WikiNodeEntry {
  id: number;
  workspaceId: number;
  wikiSpaceId: number;
  parentId: number | null;
  kind: WikiNodeKind;
  docType?: string;
  title: string;
  icon?: string;
  creatorId: number;
  creatorName: string;
  role: Role;
  revision: number;
  inheritParentAcl: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface WikiSpaceDetail {
  space: WikiSpace;
  grants: WikiSpaceGrant[];
  nodes: WikiNodeEntry[];
}
export const wikiApi = {
  listSpaces: (wsId: number, userId: number) =>
    request<{ spaces: WikiSpace[] }>("GET", `/api/workspaces/${wsId}/wiki-spaces`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }).then((r) => r.spaces ?? []),
  createSpace: (wsId: number, userId: number, input: { name: string; description?: string; icon?: string; visibility?: WikiVisibility }) =>
    request<WikiSpace>("POST", `/api/workspaces/${wsId}/wiki-spaces`, input, undefined, { "X-Jiange-User-Id": String(userId) }),
  getSpace: (spaceId: number, userId: number) =>
    request<WikiSpaceDetail>("GET", `/api/wiki/spaces/${spaceId}`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
  updateSpace: (spaceId: number, userId: number, patch: { name?: string; description?: string; icon?: string; visibility?: WikiVisibility }) =>
    request<WikiSpace>("PATCH", `/api/wiki/spaces/${spaceId}`, patch, undefined, { "X-Jiange-User-Id": String(userId) }),
  deleteSpace: (spaceId: number, userId: number) =>
    request<void>("DELETE", `/api/wiki/spaces/${spaceId}`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
  setGrant: (spaceId: number, userId: number, subjectType: WikiGrantSubjectType, subjectId: number, role: Role | "") =>
    request<{ grants: WikiSpaceGrant[] }>("PUT", `/api/wiki/spaces/${spaceId}/grants`, { subjectType, subjectId, role }, undefined, { "X-Jiange-User-Id": String(userId) }).then((r) => r.grants ?? []),
  createNode: (spaceId: number, userId: number, input: { parentId?: number | null; kind: WikiNodeKind | "board"; docType?: string; title?: string }) =>
    request<WikiNodeEntry>("POST", `/api/wiki/spaces/${spaceId}/nodes`, input, undefined, { "X-Jiange-User-Id": String(userId) }),
  importFromDrive: (spaceId: number, userId: number, input: { nodeId: number; targetParentId?: number | null; expectedRevision: number }) =>
    request<WikiNodeEntry>("POST", `/api/wiki/spaces/${spaceId}/import-drive`, input, undefined, { "X-Jiange-User-Id": String(userId) }),
  moveNode: (nodeId: number, userId: number, input: { targetSpaceId: number; targetParentId?: number | null; expectedRevision: number }) =>
    request<WikiNodeEntry>("POST", `/api/wiki/nodes/${nodeId}/move`, input, undefined, { "X-Jiange-User-Id": String(userId) }),
};
export interface FileMeta {
  id: number;
  name: string;
  mime: string;
  size: number;
  personal?: boolean;
}

export interface Automation {
  id: number;
  baseId: number;
  name: string;
  enabled: boolean;
  triggerKind: "form_submit" | "record_matches" | "schedule";
  config: {
    rules?: FilterRule[];
    conj?: "and" | "or";
    notifyUsers?: number[];
    message?: string;
    webhook?: { url?: string; kind?: string; message?: string };
    schedule?: { every?: string };
  };
}
export interface DriveEntry {
  id: number;
  workspaceId: number;
  creatorId?: number;
  creatorName?: string;
  lastModifierName?: string;
  parentId: number | null;
  kind: string;
  docType?: string;
  title: string;
  icon?: string;
  role: Role;
  revision: number;
  personal?: boolean;
  createdAt?: string;
  updatedAt: string;
}
export interface DriveShortcut {
  id: number;
  workspaceId: number;
  parentId: number | null;
  personal: boolean;
  targetNodeId: number;
  title: string;
  creatorId: number;
  creatorName: string;
  createdAt: string;
  updatedAt: string;
  targetAccessible: boolean;
  targetKind?: string;
  targetDocType?: string;
  targetTitle?: string;
  targetIcon?: string;
  targetWikiSpaceId?: number | null;
}
export const driveApi = {
  uploadFile: async (file: File, parentId: number | null, personal: boolean, signal?: AbortSignal, expectedUserId?: number): Promise<DriveEntry> => {
    const body = new FormData(); body.append("file", file); if (parentId !== null) body.append("parentId", String(parentId)); body.append("scope", personal ? "personal" : "shared");
    const response = await fetch(expectedUserId === undefined ? "/api/drive/files" : "/api/drive/batch/files", { method: "POST", body, headers: { "X-Jiange-Upload": "1", ...(expectedUserId === undefined ? {} : { "X-Jiange-User-Id": String(expectedUserId) }) }, signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, data.error ?? "error", data.message ?? response.statusText);
    return data as DriveEntry;
  },
  file: (nodeId: number) => request<FileMeta>("GET", `/api/drive/files/${nodeId}`),
  create: (title: string, parentId: number | null = null, personal = false, signal?: AbortSignal, expectedUserId?: number) =>
    request<DriveEntry>("POST", expectedUserId === undefined ? "/api/drive/folders" : "/api/drive/batch/folders", { title, parentId, scope: personal ? "personal" : "shared" }, signal, expectedUserId === undefined ? undefined : { "X-Jiange-User-Id": String(expectedUserId) }),
  createNode: (kind: "doc" | "base" | "folder" | "slides" | "sheet" | "survey", title: string, parentId: number | null = null, personal = false, docType?: "board") =>
    request<DriveEntry>("POST", "/api/drive/nodes", { kind, title, parentId, scope: personal ? "personal" : "shared", ...(docType ? { docType } : {}) }),
  createWordImportNode: (title: string, parentId: number | null, personal: boolean, userId: number, docType?: "board") =>
    request<DriveEntry>("POST", "/api/drive/word-import-nodes", { kind: "doc", title, parentId, scope: personal ? "personal" : "shared", ...(docType ? { docType } : {}) }, undefined, { "X-Jiange-User-Id": String(userId) }),
  children: (parentId: number | null = null, personal = false, workspaceId?: number) => {
    const params = new URLSearchParams();
    if (parentId !== null) params.set("parent", String(parentId));
    if (personal) params.set("scope", "personal");
    if (workspaceId !== undefined) params.set("workspaceId", String(workspaceId));
    const query = params.toString();
    return request<{ entries: DriveEntry[] }>("GET", `/api/drive/children${query ? `?${query}` : ""}`).then((r) => r.entries);
  },
  shortcuts: (parentId: number | null = null, personal = false, workspaceId?: number) => {
    const params = new URLSearchParams();
    if (parentId !== null) params.set("parent", String(parentId));
    if (personal) params.set("scope", "personal");
    if (workspaceId !== undefined) params.set("workspaceId", String(workspaceId));
    const query = params.toString();
    return request<{ shortcuts: DriveShortcut[] }>("GET", `/api/drive/shortcuts${query ? `?${query}` : ""}`).then((r) => r.shortcuts);
  },
  createShortcut: (targetNodeId: number, parentId: number | null, personal: boolean, userId: number, title = "") =>
    request<DriveShortcut>("POST", "/api/drive/shortcuts", { targetNodeId, parentId, scope: personal ? "personal" : "shared", ...(title ? { title } : {}) }, undefined, { "X-Jiange-User-Id": String(userId) }),
  deleteShortcut: (shortcutId: number, userId: number) =>
    request<void>("DELETE", `/api/drive/shortcuts/${shortcutId}`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
  move: (id: number, parentId: number | null, expected: number) =>
    request<void>("POST", `/api/drive/move/${id}`, { parentId, expected }),
  moveForAccount: (id: number, parentId: number | null, expected: number, userId: number) =>
    request<void>("POST", `/api/drive/account-move/${id}`, { parentId, expected }, undefined, { "X-Jiange-User-Id": String(userId) }),
  rename: (id: number, title: string, expected: number) =>
    request<DriveEntry>("POST", `/api/drive/rename/${id}`, { title, expected }),
  renameSlidesForAccount: (id: number, title: string, expectedTitle: string, expected: number, userId: number) =>
    request<DriveEntry>("POST", `/api/slides/${id}/account-title`, { title, expectedTitle, expected }, undefined, { "X-Jiange-User-Id": String(userId) }),
  ancestors: (id: number) =>
    request<{ ancestors: DocMeta[] }>("GET", `/api/docs/${id}/ancestors`).then((r) => r.ancestors),
  trash: (id: number, expected: number) => request<void>("POST", `/api/drive/trash/${id}`, { expected }),
  trashForAccount: async (id: number, userId: number, expected: number) => {
    const response = await fetch(`/api/drive/account-trash/${id}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Jiange-User-Id": String(userId) }, body: JSON.stringify({ expected }) });
    if (response.status === 204) return;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, data.error ?? "error", data.message ?? response.statusText);
    throw new ApiError(502, "invalid_receipt", "删除结果未确认，请刷新并检查回收站。");
  },
  restore: (id: number, expected: number) => request<void>("POST", `/api/drive/restore/${id}`, { expected }),
  purge: (id: number, expected: number) => request<void>("POST", `/api/drive/purge/${id}`, { expected }),
  // 回收站列表走既有 /api/trash（条目已带 driveRevision/trashBatchId，供乐观并发还原）
  trashList: () => request<{ docs: DocMeta[] }>("GET", "/api/trash").then((r) => r.docs),
};

const slideShapeKinds = new Set(["rectangle", "ellipse", "triangle", "rounded-rectangle", "right-triangle", "diamond", "pentagon", "hexagon", "star", "parallelogram", "trapezoid", "arrow-right", "line", "line-arrow", "line-arrow-filled", "line-dot", "line-double-arrow", "text", "image"]);
export const slidesApi = {
  duplicateDeck: (id: number, userId: number, signal: AbortSignal) => request<DocMeta>("POST", `/api/docs/${id}/duplicate`, undefined, signal, { "X-Jiange-User-Id": String(userId) }),
  pages: (deckId: number, userId: number) => request<{ pages: SlidesPage[]; presentationProtocol?: number }>("GET", `/api/slides/${deckId}/pages`, undefined, undefined, { "X-Jiange-Slides-Version": "5", "X-Jiange-User-Id": String(userId) }).then((r) => {
    if (r?.presentationProtocol !== 5 || !Array.isArray(r.pages) || r.pages.some((page) => !page || typeof page !== "object" || Array.isArray(page) || typeof page.hidden !== "boolean" || !Array.isArray(page.shapes) || page.shapes.some((shape) => !shape || typeof shape !== "object" || !slideShapeKinds.has(shape.kind)) || (page.layout !== "" && page.layout !== "title" && page.layout !== "blank" && page.layout !== "blank-title"))) throw new ApiError(426, "slide_server_outdated", "服务端不支持当前幻灯片布局，请升级后重试。");
    return r.pages;
  }),
  create: (deckId: number, title: string) => request<SlidesPage>("POST", `/api/slides/${deckId}/pages`, { title }),
  insertPage: (deckId: number, userId: number, afterPageId: number, expectedRevision: number, layout: SlideCreationLayout = "") => request<SlidesPage>("POST", `/api/slides/${deckId}/pages/insert`, { afterPageId, expectedRevision, ...(layout ? { layout } : {}) }, undefined, { "X-Jiange-User-Id": String(userId), ...(layout ? { "X-Jiange-Slides-Version": "4" } : {}) }),
  duplicatePage: (deckId: number, pageId: number, userId: number, expectedRevision: number) => request<SlidesPage>("POST", `/api/slides/${deckId}/pages/${pageId}/duplicate`, { expectedRevision }, undefined, { "X-Jiange-User-Id": String(userId) }),
  pastePage: (deckId: number, userId: number, sourceId: number, sourceRevision: number, anchorId: number, anchorRevision: number) => request<SlidesPage>("POST", `/api/slides/${deckId}/pages/paste`, { sourceId, sourceRevision, anchorId, anchorRevision }, undefined, { "X-Jiange-User-Id": String(userId) }),
  pastePageFrom: (deckId: number, userId: number, sourceDeckId: number, sourceId: number, sourceRevision: number, anchorId: number, anchorRevision: number) => request<unknown>("POST", `/api/slides/${deckId}/pages/paste-from`, { sourceDeckId, sourceId, sourceRevision, anchorId, anchorRevision }, undefined, { "X-Jiange-User-Id": String(userId) }),
  setPageHidden: (deckId: number, pageId: number, userId: number, expectedRevision: number, hidden: boolean) => request<SlidesPage>("PATCH", `/api/slides/${deckId}/pages/${pageId}/visibility`, { hidden, expectedRevision }, undefined, { "X-Jiange-User-Id": String(userId) }),
  applyBackground: (deckId: number, userId: number, background: string, expected: { id: number; revision: number }[]) => request<{ pages: unknown }>("POST", `/api/slides/${deckId}/background-all`, { background, expected }, undefined, { "X-Jiange-User-Id": String(userId) }),
  changeBackgrounds: (deckId: number, userId: number, changes: { id: number; revision: number; background: string }[]) => request<{ pages: unknown }>("POST", `/api/slides/${deckId}/background-changes`, { changes }, undefined, { "X-Jiange-User-Id": String(userId) }),
  update: (deckId: number, pid: number, userId: number, title: string, body: string, background: string, layout: SlideLayout, expectedRevision: number, notes?: string, shapes?: SlideShape[]) =>
    request<SlidesPage>("PATCH", `/api/slides/${deckId}/pages/${pid}/content`, { title, body, background, layout, expectedRevision, ...(notes === undefined ? {} : { notes }), ...(shapes === undefined ? {} : { shapes }) }, undefined, { "X-Jiange-User-Id": String(userId), "X-Jiange-Slides-Version": "5" }),
  removeVersion: (deckId: number, pageId: number, userId: number, expectedRevision: number) => request<{ deletedId: number; slidesId: number; revision: number }>("POST", `/api/slides/${deckId}/pages/${pageId}/delete`, { expectedRevision }, undefined, { "X-Jiange-User-Id": String(userId) }),
  reorder: (deckId: number, userId: number, expected: { id: number; pos: number }[], pageId: number, to: number) => request<{ positions: unknown }>("POST", `/api/slides/${deckId}/pages/reorder`, { expected, pageId, to }, undefined, { "X-Jiange-User-Id": String(userId) }),
  uploadImage: async (deckId: number, file: File, userId: number, signal: AbortSignal): Promise<FileMeta & { docId: number }> => {
    const data = new FormData(); data.append("file", file);
    const res = await fetch(`/api/slides/${deckId}/images`, { method: "POST", body: data, signal, headers: { "X-Jiange-Upload": "1", "X-Jiange-User-Id": String(userId) } });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, result.error ?? "error", result.message ?? res.statusText);
    return result as FileMeta & { docId: number };
  },
};

export interface SheetBorders {
  top?: boolean;
  right?: boolean;
  bottom?: boolean;
  left?: boolean;
  color?: string;
}

export type SheetNumFmt = "" | "general" | "currency" | "percent" | "decimal2" | "decimal1" | "integer" | "date";

export interface SheetCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  bg?: string;
  align?: "left" | "center" | "right" | "";
  valign?: "top" | "middle" | "bottom" | "";
  wrap?: boolean;
  borders?: SheetBorders;
  numFmt?: SheetNumFmt;
}

export interface SheetMerge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface SheetColumnFilter {
  query?: string;
  values?: string[];
}

export interface SheetSortRule {
  col: number;
  ascending: boolean;
}

export interface SheetFilterConfig {
  enabled?: boolean;
  headerRow?: number;
  rules?: Record<string, SheetColumnFilter>;
  sort?: SheetSortRule;
}

export interface SheetAxis {
  id: number;
  pos: number;
  size?: number;
}

export interface SheetCell {
  rowId: number;
  columnId: number;
  raw: string;
  style?: SheetCellStyle;
  revision: number;
}

export interface SheetDataValidation {
  id: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  type: "list" | "number" | "date";
  options?: string[];
  min?: string;
  max?: string;
  strict: boolean;
  hint?: string;
}

export type SheetCondFormatOp =
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "eq"
  | "neq"
  | "between"
  | "contains"
  | "empty"
  | "not_empty";

export interface SheetConditionalFormat {
  id: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  op: SheetCondFormatOp;
  value1?: string;
  value2?: string;
  bg?: string;
  color?: string;
  bold?: boolean;
}

export interface SheetProtectedRange {
  id: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  description?: string;
  allowedUserIds?: number[];
}

export interface SheetComment {
  id: number;
  nodeId: number;
  worksheetId: number;
  rowId: number;
  columnId: number;
  authorId: number;
  authorName: string;
  body: string;
  resolved: boolean;
  resolvedBy?: number;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SheetWorksheet {
  id: number;
  nodeId: number;
  title: string;
  pos: number;
  frozenRows: number;
  frozenCols: number;
  merges: SheetMerge[];
  filter: SheetFilterConfig;
  validations?: SheetDataValidation[];
  conditionalFormats?: SheetConditionalFormat[];
  protectedRanges?: SheetProtectedRange[];
  revision: number;
  rows: SheetAxis[];
  columns: SheetAxis[];
  cells: SheetCell[];
}

export interface SheetSnapshot {
  nodeId: number;
  workspaceId: number;
  parentId: number | null;
  title: string;
  role: Role;
  creatorId: number;
  creatorName: string;
  driveRevision: number;
  workbookRevision: number;
  sheets: SheetWorksheet[];
  updatedAt: string;
}

export interface SheetCellWrite {
  rowId: number;
  columnId: number;
  expectedRevision: number;
  raw?: string;
  style?: SheetCellStyle;
}

export interface SheetCellBatch {
  mutationId: string;
  worksheetId: number;
  cells: SheetCellWrite[];
}

export interface SheetCellRevision {
  rowId: number;
  columnId: number;
  revision: number;
}

export interface SheetBatchResult {
  mutationId: string;
  worksheetId: number;
  workbookRevision: number;
  cells: SheetCellRevision[];
  replayed: boolean;
}

export interface WorksheetPatch {
  title?: string;
  pos?: number;
  frozenRows?: number;
  frozenCols?: number;
  merges?: SheetMerge[];
  filter?: SheetFilterConfig;
  validations?: SheetDataValidation[];
  conditionalFormats?: SheetConditionalFormat[];
  protectedRanges?: SheetProtectedRange[];
  expectedRevision?: number;
}

export interface SheetAxisOp {
  op: "insert_row" | "delete_row" | "resize_row" | "insert_col" | "delete_col" | "resize_col";
  index: number;
  count?: number;
  size?: number;
  expectedRevision?: number;
}

export interface ImportedSheetCell {
  row: number;
  col: number;
  raw: string;
  style?: SheetCellStyle;
}

export interface ImportedWorksheet {
  title: string;
  rows: number;
  cols: number;
  frozenRows?: number;
  frozenCols?: number;
  merges?: SheetMerge[];
  cells: ImportedSheetCell[];
}

const sheetHeaders = (userId: number) => ({
  "X-Jiange-User-Id": String(userId),
  "X-Jiange-Sheet-Version": "1",
});

export const sheetsApi = {
  get: (nodeId: number, userId: number) =>
    request<SheetSnapshot>("GET", `/api/sheets/${nodeId}`, undefined, undefined, sheetHeaders(userId)),
  renameTitle: (nodeId: number, userId: number, title: string, expectedTitle: string, expected: number) =>
    request<DriveEntry>("POST", `/api/sheets/${nodeId}/account-title`, { title, expectedTitle, expected }, undefined, sheetHeaders(userId)),
  writeCells: (nodeId: number, userId: number, batch: SheetCellBatch, signal?: AbortSignal) =>
    request<SheetBatchResult>("POST", `/api/sheets/${nodeId}/cells`, batch, signal, sheetHeaders(userId)),
  createWorksheet: (nodeId: number, userId: number, title = "") =>
    request<{ worksheet: SheetWorksheet; workbookRevision: number }>("POST", `/api/sheets/${nodeId}/worksheets`, { title }, undefined, sheetHeaders(userId)),
  updateWorksheet: (nodeId: number, worksheetId: number, userId: number, patch: WorksheetPatch) =>
    request<{ worksheet: SheetWorksheet; workbookRevision: number }>("PATCH", `/api/sheets/${nodeId}/worksheets/${worksheetId}`, patch, undefined, sheetHeaders(userId)),
  deleteWorksheet: (nodeId: number, worksheetId: number, userId: number) =>
    request<{ workbookRevision: number }>("DELETE", `/api/sheets/${nodeId}/worksheets/${worksheetId}`, undefined, undefined, sheetHeaders(userId)),
  mutateAxis: (nodeId: number, worksheetId: number, userId: number, op: SheetAxisOp) =>
    request<{ worksheet: SheetWorksheet; workbookRevision: number }>("POST", `/api/sheets/${nodeId}/worksheets/${worksheetId}/axes`, op, undefined, sheetHeaders(userId)),
  importXlsx: (nodeId: number, userId: number, expectedWorkbookRevision: number, mutationId: string, sheets: ImportedWorksheet[]) =>
    request<SheetSnapshot>("POST", `/api/sheets/${nodeId}/import-xlsx`, { expectedWorkbookRevision, mutationId, sheets }, undefined, sheetHeaders(userId)),
  duplicate: (nodeId: number, userId: number, signal?: AbortSignal) =>
    request<DocMeta>("POST", `/api/docs/${nodeId}/account-duplicate`, undefined, signal, { "X-Jiange-User-Id": String(userId) }),
  listComments: (nodeId: number, userId: number, worksheetId?: number) =>
    request<{ comments: SheetComment[] }>(
      "GET",
      `/api/sheets/${nodeId}/comments${worksheetId ? `?worksheetId=${worksheetId}` : ""}`,
      undefined,
      undefined,
      sheetHeaders(userId),
    ),
  createComment: (nodeId: number, userId: number, body: { worksheetId: number; rowId: number; columnId: number; body: string }) =>
    request<{ comment: SheetComment }>("POST", `/api/sheets/${nodeId}/comments`, body, undefined, sheetHeaders(userId)),
  updateComment: (nodeId: number, userId: number, commentId: number, patch: { body?: string; resolved?: boolean }) =>
    request<{ comment: SheetComment }>("PATCH", `/api/sheets/${nodeId}/comments/${commentId}`, patch, undefined, sheetHeaders(userId)),
  deleteComment: (nodeId: number, userId: number, commentId: number) =>
    request<void>("DELETE", `/api/sheets/${nodeId}/comments/${commentId}`, undefined, undefined, sheetHeaders(userId)),
};
export interface SearchFilters {
  kind?: string;
  owner?: string;
  folderId?: number;
  updatedFrom?: string;
  updatedTo?: string;
}

export const extrasApi = {
  search: (q: string, signal?: AbortSignal, filters?: SearchFilters) => {
    const params: string[] = [`q=${encodeURIComponent(q)}`];
    if (filters?.kind && filters.kind !== "all") params.push(`kind=${encodeURIComponent(filters.kind)}`);
    if (filters?.owner && filters.owner !== "all") params.push(`owner=${encodeURIComponent(filters.owner)}`);
    if (filters?.folderId && filters.folderId > 0) params.push(`folderId=${encodeURIComponent(String(filters.folderId))}`);
    if (filters?.updatedFrom) params.push(`updatedFrom=${encodeURIComponent(filters.updatedFrom)}`);
    if (filters?.updatedTo) params.push(`updatedTo=${encodeURIComponent(filters.updatedTo)}`);
    return request<{ docs?: DocMeta[] }>("GET", `/api/search?${params.join("&")}`, undefined, signal).then((r) => {
      if (!Array.isArray(r?.docs)) throw new ApiError(502, "search_incomplete", "搜索未完成，请稍后重试。");
      return r.docs;
    });
  },
  favorites: () => request<{ docs: DocMeta[] }>("GET", "/api/favorites").then((r) => r.docs),
  star: (id: number) => request<void>("PUT", `/api/docs/${id}/star`),
  unstar: (id: number) => request<void>("DELETE", `/api/docs/${id}/star`),
  /** 置顶文档 (per user, independent of 收藏). */
  pins: () => request<{ docs: DocMeta[] }>("GET", "/api/pins").then((r) => r.docs),
  pin: (id: number) => request<void>("PUT", `/api/docs/${id}/pin`),
  unpin: (id: number) => request<void>("DELETE", `/api/docs/${id}/pin`),
  favoritesForAccount: (userId: number) => request<{ docs: DocMeta[] }>("GET", "/api/account-favorites", undefined, undefined, { "X-Jiange-User-Id": String(userId) }).then((r) => { if (!Array.isArray(r?.docs)) throw new ApiError(502, "invalid_response", "收藏列表不可用"); return r.docs; }),
  pinsForAccount: (userId: number) => request<{ docs: DocMeta[] }>("GET", "/api/account-pins", undefined, undefined, { "X-Jiange-User-Id": String(userId) }).then((r) => { if (!Array.isArray(r?.docs)) throw new ApiError(502, "invalid_response", "置顶列表不可用"); return r.docs; }),
  favoriteForAccount: (id: number, userId: number, starred: boolean) => request<void>(starred ? "PUT" : "DELETE", `/api/docs/${id}/account-star`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
  pinForAccount: (id: number, userId: number, pinned: boolean) => request<void>(pinned ? "PUT" : "DELETE", `/api/docs/${id}/account-pin`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
  ancestors: (id: number) => request<{ ancestors: DocMeta[] }>("GET", `/api/docs/${id}/ancestors`).then((r) => r.ancestors),
};
export const docsApi = {
  list: () => request<{ docs: DocMeta[] }>("GET", "/api/docs").then((r) => r.docs),
  referenceVisibility: (id: number, userId: number, signal?: AbortSignal) => request<unknown>("GET", `/api/docs/${id}/reference-visibility`, undefined, signal, { "X-Jiange-User-Id": String(userId) }).then(checkedReferenceVisibility),
  setReferenceVisibility: (id: number, userId: number, visible: boolean, expectedRevision: number) => request<unknown>("PUT", `/api/docs/${id}/reference-visibility`, { visible, expectedRevision }, undefined, { "X-Jiange-User-Id": String(userId) }).then((value) => {
    const result = checkedReferenceVisibility(value);
    if (result.visible !== visible || (result.revision !== expectedRevision && result.revision !== expectedRevision + 1)) throw new TypeError("无法确认显示设置");
    return result;
  }),
  pasteTarget: (id: number, userId: number, signal: AbortSignal) => request<{ id?: unknown; title?: unknown }>("GET", `/api/docs/${id}/paste-target`, undefined, signal, { "X-Jiange-User-Id": String(userId) }).then((result) => {
    if (!result || result.id !== id || typeof result.title !== "string") throw new TypeError("无法确认文档名称");
    return result.title;
  }),
  pasteShareTarget: (token: string, userId: number, signal: AbortSignal, publicLink = false) => request<{ id?: unknown; title?: unknown }>("GET", `/api/share/${encodeURIComponent(token)}/paste-target${publicLink ? "?public=1" : ""}`, undefined, signal, { "X-Jiange-User-Id": String(userId) }).then((result) => {
    if (!result || !Number.isSafeInteger(result.id) || Number(result.id) <= 0 || typeof result.title !== "string") throw new TypeError("无法确认文档名称");
    return result.title;
  }),
  recent: () => request<{ docs: RecentDoc[] }>("GET", "/api/recent").then((r) => r.docs),
  recordVisit: (id: number) => request<void>("POST", `/api/docs/${id}/visit`),
  get: (id: number) => request<DocMeta>("GET", `/api/docs/${id}`),
  getIcon: (id: number) => request<{ icon: string; revision: number }>("GET", `/api/docs/${id}/icon`),
  setIcon: (id: number, icon: string, expectedRevision: number) => request<{ icon: string; revision: number } | undefined>("PUT", `/api/docs/${id}/icon`, { icon, expectedRevision }),
  create: (title = "", parentId: number | null = null, workspaceId?: number, docType?: "board") => request<DocMeta>("POST", "/api/docs", { title, parentId, ...(workspaceId === undefined ? {} : { workspaceId }), ...(docType ? { docType } : {}) }),
  shares: (id: number) => request<ShareInfo>("GET", `/api/docs/${id}/shares`),
  sharesForAccount: (id: number, userId: number) => request<ShareInfo>("GET", `/api/docs/${id}/shares-account`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
  share: (id: number, email: string, role: Role | "", createOnly = false) => request<ShareInfo | undefined>("PUT", `/api/docs/${id}/shares`, { email, role, ...(createOnly ? { createOnly: true } : {}) }),
  setSubjectShare: (id: number, subjectType: "department" | "group", subjectId: number, role: Role | "", userId: number) =>
    request<ShareInfo | undefined>("PUT", `/api/docs/${id}/subject-shares`, { subjectType, subjectId, role }, undefined, { "X-Jiange-User-Id": String(userId) }),
  setInheritance: (id: number, inheritParentAcl: boolean, userId: number) =>
    request<ShareInfo | undefined>("PUT", `/api/docs/${id}/inheritance`, { inheritParentAcl }, undefined, { "X-Jiange-User-Id": String(userId) }),
  setLink: (id: number, role: "none" | "anon" | "view" | "edit") => request<ShareInfo["link"] | undefined>("PUT", `/api/docs/${id}/link`, { role }),
  setLinkAtRevision: (id: number, role: ShareInfo["link"]["role"], expectedRevision: number, userId: number, signal?: AbortSignal) => request<ShareInfo["link"] | undefined>("PUT", `/api/docs/${id}/link-guarded`, { role, expectedRevision }, signal, { "X-Jiange-User-Id": String(userId) }).then((link) => {
    if (link !== undefined && (link.role !== role || !Number.isSafeInteger(link.revision) || link.revision! < expectedRevision)) throw new TypeError("链接修改结果无法确认");
    return link;
  }),
  join: (token: string) => request<DocMeta>("POST", `/api/share/${token}`),
  joinForAccount: (token: string, userId: number, signal?: AbortSignal) => request<DocMeta>("POST", `/api/share/${encodeURIComponent(token)}/join-guarded`, undefined, signal, { "X-Jiange-User-Id": String(userId) }),
  shared: () => request<{ docs: DocMeta[] }>("GET", "/api/shared").then((r) => r.docs),
  upload: async (id: number, f: File, onProgress?: (percent: number) => void): Promise<FileMeta> => {
    const fd = new FormData();
    fd.append("file", f);
    if (onProgress && typeof XMLHttpRequest !== "undefined") return uploadWithProgress(`/api/docs/${id}/files`, fd, onProgress);
    const res = await fetch(`/api/docs/${id}/files`, {
      method: "POST",
      body: fd,
      headers: { "X-Jiange-Upload": "1" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText);
    return data as FileMeta;
  },
  uploadImportImage: async (id: number, f: File, userId: number): Promise<FileMeta> => {
    const body = new FormData();
    body.append("file", f);
    const response = await fetch(`/api/docs/${id}/import-images`, { method: "POST", body, headers: { "X-Jiange-Upload": "1", "X-Jiange-User-Id": String(userId) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, data.error ?? "error", data.message ?? response.statusText);
    return data as FileMeta;
  },
  copyClipboardAssets: (id: number, sourceDocId: number, fileIds: number[], requestId: string, userId: number, signal: AbortSignal) =>
    request<{ mapping: Record<string, number> }>("POST", `/api/docs/${id}/clipboard-assets`, { sourceDocId, fileIds, requestId }, signal, { "X-Jiange-User-Id": String(userId) }),
  versions: (id: number) => request<{ versions: Version[] }>("GET", `/api/docs/${id}/versions`).then((r) => r.versions),
  versionEntries: (id: number, userId: number, scope?: "saved" | "history") => request<{ versions: VersionEntry[] }>("GET", `/api/docs/${id}/version-entries${scope ? `?scope=${scope}` : ""}`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }).then((r) => r.versions),
  createVersionEntry: (id: number, label: string, expectedSeq: number, historyEpoch: number, requestId: string, userId: number, signal: AbortSignal) => request<VersionEntry>("POST", `/api/docs/${id}/version-entries`, { label, expectedSeq, historyEpoch, requestId }, signal, { "X-Jiange-User-Id": String(userId) }),
  deletedVersionEntries: (id: number, userId: number) => request<{ versions: DeletedVersionEntry[] }>("GET", `/api/docs/${id}/version-entries/trash`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }).then((r) => r.versions),
  manageVersionEntry: (id: number, entryId: string, expectedRevision: number, action: "rename" | "delete" | "restore", userId: number, label?: string) => request<void>("PATCH", `/api/docs/${id}/version-entries/${encodeURIComponent(entryId)}`, { action, expectedRevision, ...(label === undefined ? {} : { label }) }, undefined, { "X-Jiange-User-Id": String(userId) }),
  createVersion: (id: number, label: string) => request<Version>("POST", `/api/docs/${id}/versions`, { label }),
  createNamedVersion: (id: number, label: string, expectedSeq: number, historyEpoch: number, userId: number, signal: AbortSignal) => request<Version>("POST", `/api/docs/${id}/named-version`, { label, expectedSeq, historyEpoch }, signal, { "X-Jiange-User-Id": String(userId) }),
  versionPreview: (id: number, seq: number, userId?: number) => request<{ seq: number; view: DocView }>("GET", `/api/docs/${id}/versions/${seq}`, undefined, undefined, userId === undefined ? undefined : { "X-Jiange-User-Id": String(userId) }),
  savedVersionPreview: (id: number, entryId: string, seq: number, userId: number) => request<{ id: string; seq: number; view: DocView }>("GET", `/api/docs/${id}/version-entries/${encodeURIComponent(entryId)}/preview`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }).then((result) => {
    if (result.id !== entryId || result.seq !== seq || !Array.isArray(result.view?.blocks)) throw new Error("版本数据不匹配");
    return result;
  }),
  restoreVersion: (id: number, seq: number, userId: number, signal?: AbortSignal) => request<{ restored: number }>("POST", `/api/docs/${id}/versions/${seq}/restore-guarded`, undefined, signal, { "X-Jiange-User-Id": String(userId) }),
  trash: (id: number) => request<void>("DELETE", `/api/docs/${id}`),
  listTrash: () => request<{ docs: DocMeta[] }>("GET", "/api/trash").then((r) => r.docs),
  restore: (id: number) => request<void>("POST", `/api/trash/${id}/restore`),
  move: (id: number, parentId: number | null) => request<DocMeta>("PATCH", `/api/docs/${id}`, { move: true, parentId }),
  // A committed write can return 204 if access was lost before metadata refresh.
  rename: (id: number, title: string) => request<DocMeta | undefined>("PATCH", `/api/docs/${id}`, { title }),
  setCopyProtected: (id: number, on: boolean, expectedCopyProtected?: boolean) => request<DocMeta | undefined>("PATCH", `/api/docs/${id}`, { copyProtected: on, ...(expectedCopyProtected === undefined ? {} : { expectedCopyProtected }) }),
  setContentPermissions: (id: number, change: { copyMinRole?: Role; downloadMinRole?: Role; commentMinRole?: "view" | "edit" }, expectedPermissionsRevision: number) => request<DocMeta | undefined>("PATCH", `/api/docs/${id}`, { ...change, expectedPermissionsRevision }),
  duplicate: (id: number) => request<DocMeta>("POST", `/api/docs/${id}/duplicate`),
  duplicateForAccount: (id: number, userId: number, options?: { parentId?: number | null; personal?: boolean; workspaceId?: number; title?: string }) =>
    request<DocMeta>("POST", `/api/docs/${id}/account-duplicate`, options, undefined, { "X-Jiange-User-Id": String(userId) }),
  getForAccount: (id: number, userId: number) => request<DocMeta>("GET", `/api/docs/${id}/account-metadata`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
};

/** 带进度的上传（fetch 无上传进度事件）。错误格式与 request 一致。 */
function uploadWithProgress(url: string, body: FormData, onProgress: (percent: number) => void): Promise<FileMeta> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("X-Jiange-Upload", "1");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.min(99, (e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new ApiError(0, "network", "网络错误"));
    xhr.onload = () => {
      let data: { error?: string; message?: string } & Partial<FileMeta> = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* 非 JSON */ }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new ApiError(xhr.status, data.error ?? "error", data.message ?? xhr.statusText));
      onProgress(100);
      resolve(data as FileMeta);
    };
    xhr.send(body);
  });
}
