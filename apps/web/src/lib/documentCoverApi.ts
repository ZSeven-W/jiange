import { ApiError, docsApi, type DocMeta } from "@/lib/api";

/** The server owns the cover and its monotonic revision. */
export type DocumentCover =
  | { kind: "none"; position: number; revision: number }
  | { kind: "builtin"; asset: string; position: number; revision: number }
  | { kind: "file"; fileId: number; position: number; revision: number };

export type CoverChoice =
  | { kind: "none"; position: number }
  | { kind: "builtin"; asset: string; position: number }
  | { kind: "file"; fileId: number; position: number };

// Only assets actually shipped with this application may become image URLs.
// Unknown future IDs remain parseable, but are never interpolated into a URL.
export const COVER_GALLERY = [{ id: "misty-lake", label: "湖光山色", src: "/covers/misty-lake.webp" }] as const;

export function parseDocumentCover(value: unknown): DocumentCover | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 0 || typeof item.position !== "number" || !Number.isFinite(item.position) || item.position < 0 || item.position > 1) return undefined;
  const common = { position: item.position, revision: item.revision as number };
  if (item.kind === "none") return { kind: "none", ...common };
  if (item.kind === "builtin" && typeof item.asset === "string" && item.asset.length > 0 && item.asset.length <= 100) return { kind: "builtin", asset: item.asset, ...common };
  if (item.kind === "file" && Number.isSafeInteger(item.fileId) && (item.fileId as number) > 0) return { kind: "file", fileId: item.fileId as number, ...common };
  return undefined;
}

export function coverChoice(cover: DocumentCover): CoverChoice {
  if (cover.kind === "builtin") return { kind: "builtin", asset: cover.asset, position: cover.position };
  if (cover.kind === "file") return { kind: "file", fileId: cover.fileId, position: cover.position };
  return { kind: "none", position: cover.position };
}

export function coverImageURL(cover: DocumentCover, docId?: number, publicToken?: string): string | undefined {
  if (cover.kind === "builtin") return COVER_GALLERY.find((item) => item.id === cover.asset)?.src;
  if (cover.kind !== "file") return undefined;
  if (publicToken) return `/api/public/${encodeURIComponent(publicToken)}/cover/image?revision=${cover.revision}`;
  if (Number.isSafeInteger(docId) && (docId as number) > 0) return `/api/docs/${docId}/cover/image?revision=${cover.revision}`;
  return undefined;
}

async function coverRequest(method: "GET" | "PUT", id: number, body?: unknown): Promise<unknown> {
  const response = await fetch(`/api/docs/${id}/cover`, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined;
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data && typeof data === "object" ? data as Record<string, unknown> : {};
    throw new ApiError(response.status, typeof detail.error === "string" ? detail.error : "error", typeof detail.message === "string" ? detail.message : response.statusText);
  }
  return data;
}

export const documentCoverApi = {
  get: (id: number) => coverRequest("GET", id),
  set: (id: number, choice: CoverChoice, expectedRevision: number) => coverRequest("PUT", id, { ...choice, expectedRevision }),
};

/** Check the latest role and revision before writing; verify again after. */
export async function changeDocumentCover(
  id: number, previous: DocumentCover, next: CoverChoice,
  current: () => boolean,
  getDoc: () => Promise<DocMeta> = () => docsApi.get(id),
  getCover: () => Promise<unknown> = () => documentCoverApi.get(id),
  write: (value: CoverChoice, revision: number) => Promise<unknown> = (value, revision) => documentCoverApi.set(id, value, revision),
): Promise<DocumentCover | undefined> {
  if (!current()) throw new Error("页面状态已变化");
  const meta = await getDoc();
  if (!current()) return undefined;
  if (meta.id !== id || (meta.role !== "edit" && meta.role !== "manage")) throw new ApiError(403, "forbidden", "当前没有编辑权限");
  const latest = parseDocumentCover(await getCover());
  if (!current()) return undefined;
  if (!latest || latest.revision !== previous.revision || JSON.stringify(latest) !== JSON.stringify(previous)) throw new ApiError(409, "cover_conflict", "封面已变化");
  const response = await write(next, previous.revision);
  if (!current()) return undefined;
  const committed = response === undefined ? undefined : parseDocumentCover(response);
  if (response !== undefined && (!committed || committed.revision <= previous.revision)) throw new Error("响应无效");
  const verified = await getDoc();
  if (!current() || verified.id !== id || (verified.role !== "edit" && verified.role !== "manage")) return undefined;
  const authoritative = parseDocumentCover(await getCover());
  if (!current()) return undefined;
  if (!authoritative || (committed && authoritative.revision < committed.revision)) throw new Error("响应无效");
  return authoritative;
}
