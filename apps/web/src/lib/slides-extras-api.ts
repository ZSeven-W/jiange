import { ApiError, type SlidesPage } from "@/lib/api";

export interface SlidesComment {
  id: number;
  slidesId: number;
  pageId: number;
  shapeId: string;
  authorId: number;
  authorName: string;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SlidesVersionMeta {
  id: number;
  slidesId: number;
  label: string;
  autoSaved: boolean;
  createdBy: number;
  actorName: string;
  createdAt: string;
  pageCount: number;
}

function slidesExtrasHeaders(userId: number): Record<string, string> {
  return {
    "X-Jiange-User-Id": String(userId),
  };
}

async function slidesExtrasRequest<T>(
  method: string,
  path: string,
  userId: number,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers = slidesExtrasHeaders(userId);
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText, data);
  }
  return data as T;
}

export const slidesExtrasApi = {
  listComments: (deckId: number, userId: number, signal?: AbortSignal) =>
    slidesExtrasRequest<{ comments: SlidesComment[] }>(
      "GET",
      `/api/slides/${deckId}/comments`,
      userId,
      undefined,
      signal,
    ),

  createComment: (
    deckId: number,
    userId: number,
    input: { pageId: number; shapeId?: string; body: string },
  ) =>
    slidesExtrasRequest<{ comment: SlidesComment }>(
      "POST",
      `/api/slides/${deckId}/comments`,
      userId,
      {
        pageId: input.pageId,
        shapeId: input.shapeId ?? "",
        body: input.body,
      },
    ),

  updateComment: (
    deckId: number,
    userId: number,
    commentId: number,
    patch: { body?: string; resolved?: boolean },
  ) =>
    slidesExtrasRequest<{ comment: SlidesComment }>(
      "PATCH",
      `/api/slides/${deckId}/comments/${commentId}`,
      userId,
      patch,
    ),

  deleteComment: (deckId: number, userId: number, commentId: number) =>
    slidesExtrasRequest<void>(
      "DELETE",
      `/api/slides/${deckId}/comments/${commentId}`,
      userId,
    ),

  listVersions: (deckId: number, userId: number, signal?: AbortSignal) =>
    slidesExtrasRequest<{ versions: SlidesVersionMeta[] }>(
      "GET",
      `/api/slides/${deckId}/versions`,
      userId,
      undefined,
      signal,
    ),

  createVersion: (deckId: number, userId: number, label = "") =>
    slidesExtrasRequest<{ version: SlidesVersionMeta }>(
      "POST",
      `/api/slides/${deckId}/versions`,
      userId,
      { label },
    ),

  restoreVersion: (deckId: number, userId: number, versionId: number) =>
    slidesExtrasRequest<{ pages: SlidesPage[] }>(
      "POST",
      `/api/slides/${deckId}/versions/${versionId}/restore`,
      userId,
    ),
};
