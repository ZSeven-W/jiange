import { ApiError, type Field, type ViewConfig } from "@/lib/api";

export const isFormToken = (token: unknown): token is string => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
export const formLink = (token: string, origin: string, pathname: string) => `${origin}${pathname}#/form/${token}`;
export interface PublicationStatus { published: boolean; revision: number }
function validRevision(revision: unknown): revision is number { return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0; }
async function request(method: "GET" | "POST" | "DELETE", baseId: number, viewId: number, signal?: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(`/api/bases/${baseId}/views/${viewId}/public-form`, { method, credentials: "same-origin", cache: "no-store", signal, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 204) return undefined;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error ?? "error", data.message ?? "请求失败");
  return data;
}
export async function readFormPublication(baseId: number, viewId: number, signal?: AbortSignal): Promise<PublicationStatus> {
  const value = await request("GET", baseId, viewId, signal) as { published?: unknown; revision?: unknown };
  if (typeof value?.published !== "boolean" || !validRevision(value?.revision)) throw new Error("收集表状态无效");
  return { published: value.published, revision: value.revision };
}
export async function publishForm(baseId: number, viewId: number, expectedRevision: number, expectedConfig: ViewConfig, expectedFields: Field[], signal?: AbortSignal): Promise<{ token: string; revision: number }> {
  const value = await request("POST", baseId, viewId, signal, { expectedRevision, expectedConfig, expectedFields }) as { token?: unknown; revision?: unknown };
  if (!isFormToken(value?.token) || !validRevision(value?.revision) || value.revision <= expectedRevision) throw new Error("发布结果无效");
  return { token: value.token, revision: value.revision };
}
export async function closeForm(baseId: number, viewId: number, expectedRevision: number, signal?: AbortSignal): Promise<PublicationStatus> {
  const value = await request("DELETE", baseId, viewId, signal, { expectedRevision }) as { published?: unknown; revision?: unknown };
  if (value?.published !== false || !validRevision(value?.revision) || value.revision <= expectedRevision) throw new Error("关闭结果无效");
  return { published: false, revision: value.revision };
}

/** A stale form or field schema must never silently overwrite concurrent edits. */
export async function saveFormConfig(baseId: number, viewId: number, expectedConfig: ViewConfig, expectedFields: Field[], config: ViewConfig, signal?: AbortSignal): Promise<ViewConfig> {
  const response = await fetch(`/api/bases/${baseId}/views/${viewId}/form-config`, { method: "POST", credentials: "same-origin", cache: "no-store", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedConfig, expectedFields, config }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error ?? "error", data.message ?? "保存失败");
  if (!data.config || typeof data.config !== "object" || Array.isArray(data.config)) throw new Error("保存结果无效");
  return data.config as ViewConfig;
}
