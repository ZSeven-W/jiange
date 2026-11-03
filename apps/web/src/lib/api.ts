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
  constructor(public status: number, public code: string, message: string) {
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
  register: (email: string, name: string, password: string) =>
    request<Me>("POST", "/api/auth/register", { email, name, password }),
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
}

export const docsApi = {
  list: () => request<{ docs: DocMeta[] }>("GET", "/api/docs").then((r) => r.docs),
  get: (id: number) => request<DocMeta>("GET", `/api/docs/${id}`),
  create: (title = "", parentId: number | null = null) => request<DocMeta>("POST", "/api/docs", { title, parentId }),
  trash: (id: number) => request<void>("DELETE", `/api/docs/${id}`),
  listTrash: () => request<{ docs: DocMeta[] }>("GET", "/api/trash").then((r) => r.docs),
  restore: (id: number) => request<void>("POST", `/api/trash/${id}/restore`),
  move: (id: number, parentId: number | null) => request<DocMeta>("PATCH", `/api/docs/${id}`, { move: true, parentId }),
  rename: (id: number, title: string) => request<DocMeta>("PATCH", `/api/docs/${id}`, { title }),
};
