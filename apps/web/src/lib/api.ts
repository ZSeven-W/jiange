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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  kind?: "doc" | "base";
  workspaceName?: string;
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
  | "modified_at";
export interface Field {
  id: number;
  name: string;
  type: FieldType;
  options?: string[];
  /** preset palette index per option (-1/absent = auto) */
  optionColors?: number[];
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
  filters?: { conj: "and" | "or"; rules: FilterRule[] };
  sorts?: { f: number; asc: boolean }[];
  group?: number;
  hidden?: number[];
}
export interface View {
  id: number;
  baseId: number;
  type: "grid" | "kanban" | "gallery" | "calendar" | "form";
  name: string;
  config: ViewConfig;
  pos: number;
}
export const baseApi = {
  create: (title?: string, parentId: number | null = null) => request<DocMeta>("POST", "/api/bases", { title, parentId }),
  get: (id: number) =>
    request<{ base: DocMeta; fields: Field[]; records: BaseRecord[]; head: number; members: User[]; views: View[] }>("GET", `/api/bases/${id}`),
  addField: (id: number, f: Partial<Field>) => request<Field>("POST", `/api/bases/${id}/fields`, f),
  patchField: (id: number, fid: number, f: Partial<Field>) => request<Field>("PATCH", `/api/bases/${id}/fields/${fid}`, f),
  deleteField: (id: number, fid: number) => request<void>("DELETE", `/api/bases/${id}/fields/${fid}`),
  addRecord: (id: number, cells: Record<string, Cell> = {}) => request<BaseRecord>("POST", `/api/bases/${id}/records`, { cells }),
  setCells: (id: number, rid: number, cells: Record<string, Cell | null>) => request<BaseRecord>("PATCH", `/api/bases/${id}/records/${rid}`, { cells }),
  moveRecord: (id: number, rid: number, position: number) => request<BaseRecord>("PATCH", `/api/bases/${id}/records/${rid}`, { move: true, position }),
  deleteRecord: (id: number, rid: number) => request<void>("DELETE", `/api/bases/${id}/records/${rid}`),
  addView: (id: number, v: Partial<View>) => request<View>("POST", `/api/bases/${id}/views`, v),
  patchView: (id: number, vid: number, v: Partial<View>) => request<View>("PATCH", `/api/bases/${id}/views/${vid}`, v),
  deleteView: (id: number, vid: number) => request<void>("DELETE", `/api/bases/${id}/views/${vid}`),
  query: (id: number, q: { filters?: ViewConfig["filters"]; sorts?: ViewConfig["sorts"]; limit?: number }) =>
    request<{ records: BaseRecord[] }>("POST", `/api/bases/${id}/query`, q),
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
  create: (id: number, c: Partial<Comment> & { body: string }) => request<Comment>("POST", `/api/docs/${id}/comments`, c),
  update: (id: number, cid: number, p: { body?: string; resolved?: boolean }) => request<Comment>("PATCH", `/api/docs/${id}/comments/${cid}`, p),
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
  link: { role: "none" | "view" | "edit"; token?: string };
  role: Role;
}
export interface FileMeta {
  id: number;
  name: string;
  mime: string;
  size: number;
}

export const extrasApi = {
  search: (q: string) => request<{ docs: DocMeta[] }>("GET", `/api/search?q=${encodeURIComponent(q)}`).then((r) => r.docs),
  favorites: () => request<{ docs: DocMeta[] }>("GET", "/api/favorites").then((r) => r.docs),
  star: (id: number) => request<void>("PUT", `/api/docs/${id}/star`),
  unstar: (id: number) => request<void>("DELETE", `/api/docs/${id}/star`),
  ancestors: (id: number) => request<{ ancestors: DocMeta[] }>("GET", `/api/docs/${id}/ancestors`).then((r) => r.ancestors),
};
export const docsApi = {
  list: () => request<{ docs: DocMeta[] }>("GET", "/api/docs").then((r) => r.docs),
  get: (id: number) => request<DocMeta>("GET", `/api/docs/${id}`),
  create: (title = "", parentId: number | null = null) => request<DocMeta>("POST", "/api/docs", { title, parentId }),
  shares: (id: number) => request<ShareInfo>("GET", `/api/docs/${id}/shares`),
  share: (id: number, email: string, role: Role | "") => request<ShareInfo>("PUT", `/api/docs/${id}/shares`, { email, role }),
  setLink: (id: number, role: "none" | "view" | "edit") => request<ShareInfo["link"]>("PUT", `/api/docs/${id}/link`, { role }),
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
  rename: (id: number, title: string) => request<DocMeta>("PATCH", `/api/docs/${id}`, { title }),
};
