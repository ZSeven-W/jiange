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
}
export interface AttachmentRef {
  id: number;
  name: string;
  mime: string;
  size: number;
}
export type Cell = string | number | boolean | string[] | AttachmentRef[];
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
  v?: string | number | boolean;
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
}
export interface View {
  id: number;
  baseId: number;
  type: "grid" | "kanban" | "gallery" | "calendar" | "form" | "gantt";
  name: string;
  config: ViewConfig;
  pos: number;
}
export const baseApi = {
  create: (title?: string, parentId: number | null = null) => request<DocMeta>("POST", "/api/bases", { title, parentId }),
  get: (id: number, signal?: AbortSignal) =>
    request<{ base: DocMeta; fields: Field[]; records: BaseRecord[]; head: number; members: User[]; views: View[]; expansions?: Record<string, unknown>; writeRestricted?: boolean }>(
      "GET",
      `/api/bases/${id}`,
      undefined,
      signal,
    ),
  /** 双向关联：反向引用列表 */
  reverse: (id: number) =>
    request<{ expansions?: { reverse?: { sourceBase: number; fieldId: number; from: Record<string, number[]>; titles: Record<string, string> }[] } }>("GET", `/api/bases/${id}`).then((r) => r.expansions?.reverse ?? []),
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
  automations: (id: number) => request<{ automations: Automation[] }>("GET", `/api/bases/${id}/automations`).then((r) => r.automations),
  addAutomation: (id: number, a: Partial<Automation>) => request<Automation>("POST", `/api/bases/${id}/automations`, a),
  updateAutomation: (id: number, aid: number, a: Partial<Automation>) => request<Automation>("PATCH", `/api/bases/${id}/automations/${aid}`, a),
  deleteAutomation: (id: number, aid: number) => request<void>("DELETE", `/api/bases/${id}/automations/${aid}`),
  addView: (id: number, v: Partial<View>) => request<View>("POST", `/api/bases/${id}/views`, v),
  patchView: (id: number, vid: number, v: Partial<View>) => request<View>("PATCH", `/api/bases/${id}/views/${vid}`, v),
  renameView: (id: number, vid: number, expectedName: string, name: string) => request<View>("POST", `/api/bases/${id}/views/${vid}/rename`, { expectedName, name }),
  duplicateView: (id: number, vid: number) => request<View>("POST", `/api/bases/${id}/views/${vid}/duplicate`, {}),
  reorderViews: (id: number, expectedViewIds: number[], viewIds: number[]) => request<{ views: View[] }>("POST", `/api/bases/${id}/views/reorder`, { expectedViewIds, viewIds }),
  deleteView: (id: number, vid: number) => request<void>("DELETE", `/api/bases/${id}/views/${vid}`),
  query: (id: number, q: { filters?: ViewConfig["filters"]; sorts?: ViewConfig["sorts"]; limit?: number }, signal?: AbortSignal) =>
    request<{ records: BaseRecord[] }>("POST", `/api/bases/${id}/query`, q, signal),
  importCSV: (id: number, csv: string, header = true, types?: string[]) =>
    request<{ imported: number; fields: number; errors: { row: number; err: string }[] }>("POST", `/api/bases/${id}/import`, { csv, header, types }),
};
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
  children: (parentId: number | null = null, personal = false) =>
    request<{ entries: DriveEntry[] }>("GET", `/api/drive/children${parentId ? `?parent=${parentId}` : ""}${personal ? `${parentId ? "&" : "?"}scope=personal` : ""}`).then((r) => r.entries),
  move: (id: number, parentId: number | null, expected: number) =>
    request<void>("POST", `/api/drive/move/${id}`, { parentId, expected }),
  rename: (id: number, title: string, expected: number) =>
    request<DriveEntry>("POST", `/api/drive/rename/${id}`, { title, expected }),
  ancestors: (id: number) =>
    request<{ ancestors: DocMeta[] }>("GET", `/api/docs/${id}/ancestors`).then((r) => r.ancestors),
  trash: (id: number, expected: number) => request<void>("POST", `/api/drive/trash/${id}`, { expected }),
  restore: (id: number, expected: number) => request<void>("POST", `/api/drive/restore/${id}`, { expected }),
  purge: (id: number, expected: number) => request<void>("POST", `/api/drive/purge/${id}`, { expected }),
  // 回收站列表走既有 /api/trash（条目已带 driveRevision/trashBatchId，供乐观并发还原）
  trashList: () => request<{ docs: DocMeta[] }>("GET", "/api/trash").then((r) => r.docs),
};

export type SlideShape = { id: string; kind: "rectangle" | "ellipse" | "triangle" | "text"; x: number; y: number; color: string; width?: number; height?: number; rotation?: number; text?: string; fontSize?: number; bold?: boolean; align?: "left" | "center" | "right" };
export interface SlidesPage {
  id: number;
  slidesId: number;
  pos: number;
  title: string;
  body: string;
  background: string;
  notes: string;
  shapes: SlideShape[];
  revision: number;
  updatedAt: string;
}
export const slidesApi = {
  pages: (deckId: number) => request<{ pages: SlidesPage[] }>("GET", `/api/slides/${deckId}/pages`).then((r) => r.pages),
  create: (deckId: number, title: string) => request<SlidesPage>("POST", `/api/slides/${deckId}/pages`, { title }),
  update: (pid: number, title: string, body: string, background: string, expectedRevision: number, notes?: string, shapes?: SlideShape[]) =>
    request<SlidesPage>("PATCH", `/api/slides/pages/${pid}`, { title, body, background, expectedRevision, ...(notes === undefined ? {} : { notes }), ...(shapes === undefined ? {} : { shapes }) }),
  remove: (pid: number) => request<void>("DELETE", `/api/slides/pages/${pid}`),
  move: (pid: number, pos: number) => request<void>("POST", `/api/slides/pages/${pid}/move`, { pos }),
};
export const extrasApi = {
  search: (q: string, signal?: AbortSignal) => request<{ docs?: DocMeta[] }>("GET", `/api/search?q=${encodeURIComponent(q)}`, undefined, signal).then((r) => {
    if (!Array.isArray(r?.docs)) throw new ApiError(502, "search_incomplete", "搜索未完成，请稍后重试。");
    return r.docs;
  }),
  favorites: () => request<{ docs: DocMeta[] }>("GET", "/api/favorites").then((r) => r.docs),
  star: (id: number) => request<void>("PUT", `/api/docs/${id}/star`),
  unstar: (id: number) => request<void>("DELETE", `/api/docs/${id}/star`),
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
  upload: async (id: number, f: File): Promise<FileMeta> => {
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch(`/api/docs/${id}/files`, {
      method: "POST",
      body: fd,
      headers: { "X-Jiange-Upload": "1" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText);
    return data as FileMeta;
  },
  versions: (id: number) => request<{ versions: Version[] }>("GET", `/api/docs/${id}/versions`).then((r) => r.versions),
  createVersion: (id: number, label: string) => request<Version>("POST", `/api/docs/${id}/versions`, { label }),
  versionPreview: (id: number, seq: number) => request<{ seq: number; view: DocView }>("GET", `/api/docs/${id}/versions/${seq}`),
  restoreVersion: (id: number, seq: number) => request<{ restored: number }>("POST", `/api/docs/${id}/versions/${seq}/restore`),
  trash: (id: number) => request<void>("DELETE", `/api/docs/${id}`),
  listTrash: () => request<{ docs: DocMeta[] }>("GET", "/api/trash").then((r) => r.docs),
  restore: (id: number) => request<void>("POST", `/api/trash/${id}/restore`),
  move: (id: number, parentId: number | null) => request<DocMeta>("PATCH", `/api/docs/${id}`, { move: true, parentId }),
  // A committed write can return 204 if access was lost before metadata refresh.
  rename: (id: number, title: string) => request<DocMeta | undefined>("PATCH", `/api/docs/${id}`, { title }),
  setCopyProtected: (id: number, on: boolean, expectedCopyProtected?: boolean) => request<DocMeta | undefined>("PATCH", `/api/docs/${id}`, { copyProtected: on, ...(expectedCopyProtected === undefined ? {} : { expectedCopyProtected }) }),
  setContentPermissions: (id: number, change: { copyMinRole?: Role; downloadMinRole?: Role; commentMinRole?: "view" | "edit" }, expectedPermissionsRevision: number) => request<DocMeta | undefined>("PATCH", `/api/docs/${id}`, { ...change, expectedPermissionsRevision }),
  duplicate: (id: number) => request<DocMeta>("POST", `/api/docs/${id}/duplicate`),
};
