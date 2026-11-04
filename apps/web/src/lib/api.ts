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
}
export type FieldType = "text" | "number" | "select" | "checkbox" | "date";
export interface Field {
  id: number;
  name: string;
  type: FieldType;
  options?: string[];
  position: number;
}
export type Cell = string | number | boolean;
export interface BaseRecord {
  id: number;
  cells: Record<string, Cell>;
  position: number;
}
export const baseApi = {
  create: (title?: string, parentId: number | null = null) => request<DocMeta>("POST", "/api/bases", { title, parentId }),
  get: (id: number) => request<{ base: DocMeta; fields: Field[]; records: BaseRecord[]; head: number }>("GET", `/api/bases/${id}`),
  addField: (id: number, f: Partial<Field>) => request<Field>("POST", `/api/bases/${id}/fields`, f),
  patchField: (id: number, fid: number, f: Partial<Field>) => request<Field>("PATCH", `/api/bases/${id}/fields/${fid}`, f),
  deleteField: (id: number, fid: number) => request<void>("DELETE", `/api/bases/${id}/fields/${fid}`),
  addRecord: (id: number, cells: Record<string, Cell> = {}) => request<BaseRecord>("POST", `/api/bases/${id}/records`, { cells }),
  setCells: (id: number, rid: number, cells: Record<string, Cell | null>) => request<BaseRecord>("PATCH", `/api/bases/${id}/records/${rid}`, { cells }),
  deleteRecord: (id: number, rid: number) => request<void>("DELETE", `/api/bases/${id}/records/${rid}`),
};
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
  trash: (id: number) => request<void>("DELETE", `/api/docs/${id}`),
  listTrash: () => request<{ docs: DocMeta[] }>("GET", "/api/trash").then((r) => r.docs),
  restore: (id: number) => request<void>("POST", `/api/trash/${id}/restore`),
  move: (id: number, parentId: number | null) => request<DocMeta>("PATCH", `/api/docs/${id}`, { move: true, parentId }),
  rename: (id: number, title: string) => request<DocMeta>("PATCH", `/api/docs/${id}`, { title }),
};
