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
) & { readonly [verifiedConditionalStatus]: true };

export function isVerifiedConditionalStatus(value: ConditionalOpsStatus): boolean { return value?.[verifiedConditionalStatus] === true; }
function verifiedStatus<T extends object>(value: T): T & { readonly [verifiedConditionalStatus]: true } {
  Object.defineProperty(value, verifiedConditionalStatus, { value: true });
  return Object.freeze(value) as T & { readonly [verifiedConditionalStatus]: true };
}

/** "unknown" is not a rejection: an earlier request may still be in flight. */
export async function queryConditionalOpsStatus(input: { docId: number; userId: number; requestId: string; signal: AbortSignal }): Promise<ConditionalOpsStatus> {
  const { docId, userId, requestId, signal } = input;
  if (![docId, userId].every(Number.isSafeInteger) || docId <= 0 || userId <= 0 || !/^[0-9a-f]{32}$/.test(requestId)) throw new ApiError(400, "invalid_request", "条件提交查询参数无效");
  const response = await fetch(`/api/docs/${docId}/conditional-ops/${requestId}`, { credentials: "same-origin", cache: "no-store", headers: { "X-Jiange-User-Id": String(userId) }, signal });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) { const error = value as { error?: string; message?: string } | null; throw new ApiError(response.status, error?.error ?? "error", error?.message ?? response.statusText); }
  const invalid = () => { throw new ApiError(502, "invalid_receipt", "无法确认提交结果，请稍后重试"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (result.docId !== docId || result.userId !== userId || result.requestId !== requestId || !Number.isSafeInteger(result.currentEpoch) || (result.currentEpoch as number) <= 0 || !Number.isSafeInteger(result.currentHead) || (result.currentHead as number) < 0) return invalid();
  const common = { docId, userId, requestId, currentEpoch: result.currentEpoch as number, currentHead: result.currentHead as number };
  if (result.state === "unknown") return verifiedStatus({ ...common, state: "unknown" as const });
  if (result.state !== "committed" && result.state !== "history_changed" || !Number.isSafeInteger(result.historyEpoch) || (result.historyEpoch as number) <= 0 || !Number.isSafeInteger(result.expectedSeq) || (result.expectedSeq as number) < 0 || !Number.isSafeInteger(result.firstSeq) || result.firstSeq !== (result.expectedSeq as number) + 1 || !Number.isSafeInteger(result.opCount) || (result.opCount as number) <= 0 || (result.opCount as number) > 100000 || (result.expectedSeq as number) + (result.opCount as number) > Number.MAX_SAFE_INTEGER || typeof result.digest !== "string" || !/^[0-9a-f]{64}$/.test(result.digest)) return invalid();
  if (result.state === "committed" && (common.currentEpoch !== result.historyEpoch || common.currentHead < (result.expectedSeq as number) + (result.opCount as number)) || result.state === "history_changed" && common.currentEpoch === result.historyEpoch) return invalid();
  return verifiedStatus({ ...common, state: result.state, historyEpoch: result.historyEpoch as number, expectedSeq: result.expectedSeq as number, firstSeq: result.firstSeq as number, opCount: result.opCount as number, digest: result.digest });
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
  kind?: "doc" | "base" | "folder" | "slides" | "file";
  workspaceName?: string;
  copyProtected?: boolean;
  copyMinRole?: Role;
  downloadMinRole?: Role;
  /** Missing on older servers, which only permit editors to comment. */
  commentMinRole?: "view" | "edit";
  permissionsRevision?: number;
  /** Versioned-drive optimistic concurrency (move/trash/restore); 0 on nodes never touched by the drive API. */
  driveRevision?: number;
  /** Groups the subtree of one guarded trash operation; 0 for legacy deletions. */
  trashBatchId?: number;
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
export interface Field {
  id: number;
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
  type: "grid" | "kanban" | "gallery" | "calendar" | "form" | "gantt";
  name: string;
  config: ViewConfig;
  pos: number;
}
type BaseSnapshot = { base: DocMeta; fields: Field[]; records: BaseRecord[]; head: number; members: User[]; views: View[]; expansions?: Record<string, unknown>; writeRestricted?: boolean };
export const baseApi = {
  create: (title?: string, parentId: number | null = null) => request<DocMeta>("POST", "/api/bases", { title, parentId }),
  get: (id: number, signal?: AbortSignal) =>
    request<BaseSnapshot>(
      "GET",
      `/api/bases/${id}`,
      undefined,
      signal,
    ),
  getForAccount: (id: number, userId: number, signal?: AbortSignal) => request<BaseSnapshot>("GET", `/api/bases/${id}/account-snapshot`, undefined, signal, { "X-Jiange-User-Id": String(userId) }),
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
  addRecord: (id: number, cells: Record<string, Cell> = {}) => request<BaseRecord>("POST", `/api/bases/${id}/records`, { cells }),
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
  addView: (id: number, v: Partial<View>) => request<View>("POST", `/api/bases/${id}/views`, v),
  addViewForAccount: (id: number, userId: number, v: Partial<View>) => request<View>("POST", `/api/bases/${id}/account-views`, v, undefined, { "X-Jiange-User-Id": String(userId) }),
  patchView: (id: number, vid: number, v: Partial<View>) => request<View>("PATCH", `/api/bases/${id}/views/${vid}`, v),
  renameView: (id: number, vid: number, expectedName: string, name: string) => request<View>("POST", `/api/bases/${id}/views/${vid}/rename`, { expectedName, name }),
  duplicateView: (id: number, vid: number) => request<View>("POST", `/api/bases/${id}/views/${vid}/duplicate`, {}),
  reorderViews: (id: number, expectedViewIds: number[], viewIds: number[]) => request<{ views: View[] }>("POST", `/api/bases/${id}/views/reorder`, { expectedViewIds, viewIds }),
  deleteView: (id: number, vid: number) => request<void>("DELETE", `/api/bases/${id}/views/${vid}`),
  query: (id: number, q: { filters?: ViewConfig["filters"]; sorts?: ViewConfig["sorts"]; limit?: number }, signal?: AbortSignal) =>
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
export interface ShareInfo {
  members: Share[];
  link: { role: "none" | "anon" | "view" | "edit"; token?: string };
  role: Role;
}
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
  title: string;
  icon?: string;
  role: Role;
  revision: number;
  personal?: boolean;
  createdAt?: string;
  updatedAt: string;
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
  createNode: (kind: "doc" | "base" | "folder" | "slides", title: string, parentId: number | null = null, personal = false) =>
    request<DriveEntry>("POST", "/api/drive/nodes", { kind, title, parentId, scope: personal ? "personal" : "shared" }),
  createWordImportNode: (title: string, parentId: number | null, personal: boolean, userId: number) =>
    request<DriveEntry>("POST", "/api/drive/word-import-nodes", { kind: "doc", title, parentId, scope: personal ? "personal" : "shared" }, undefined, { "X-Jiange-User-Id": String(userId) }),
  children: (parentId: number | null = null, personal = false, workspaceId?: number) => {
    const params = new URLSearchParams();
    if (parentId !== null) params.set("parent", String(parentId));
    if (personal) params.set("scope", "personal");
    if (workspaceId !== undefined) params.set("workspaceId", String(workspaceId));
    const query = params.toString();
    return request<{ entries: DriveEntry[] }>("GET", `/api/drive/children${query ? `?${query}` : ""}`).then((r) => r.entries);
  },
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
export const extrasApi = {
  search: (q: string, signal?: AbortSignal) => request<{ docs?: DocMeta[] }>("GET", `/api/search?q=${encodeURIComponent(q)}`, undefined, signal).then((r) => {
    if (!Array.isArray(r?.docs)) throw new ApiError(502, "search_incomplete", "搜索未完成，请稍后重试。");
    return r.docs;
  }),
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
  recent: () => request<{ docs: RecentDoc[] }>("GET", "/api/recent").then((r) => r.docs),
  recordVisit: (id: number) => request<void>("POST", `/api/docs/${id}/visit`),
  get: (id: number) => request<DocMeta>("GET", `/api/docs/${id}`),
  getIcon: (id: number) => request<{ icon: string; revision: number }>("GET", `/api/docs/${id}/icon`),
  setIcon: (id: number, icon: string, expectedRevision: number) => request<{ icon: string; revision: number } | undefined>("PUT", `/api/docs/${id}/icon`, { icon, expectedRevision }),
  create: (title = "", parentId: number | null = null, workspaceId?: number) => request<DocMeta>("POST", "/api/docs", { title, parentId, ...(workspaceId === undefined ? {} : { workspaceId }) }),
  shares: (id: number) => request<ShareInfo>("GET", `/api/docs/${id}/shares`),
  share: (id: number, email: string, role: Role | "", createOnly = false) => request<ShareInfo | undefined>("PUT", `/api/docs/${id}/shares`, { email, role, ...(createOnly ? { createOnly: true } : {}) }),
  setLink: (id: number, role: "none" | "anon" | "view" | "edit") => request<ShareInfo["link"] | undefined>("PUT", `/api/docs/${id}/link`, { role }),
  join: (token: string) => request<DocMeta>("POST", `/api/share/${token}`),
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
  duplicateForAccount: (id: number, userId: number) => request<DocMeta>("POST", `/api/docs/${id}/account-duplicate`, undefined, undefined, { "X-Jiange-User-Id": String(userId) }),
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
