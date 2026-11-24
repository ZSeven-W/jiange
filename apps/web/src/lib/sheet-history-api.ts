import { ApiError, type SheetSnapshot } from "@/lib/api";

export interface SheetVersionMeta {
  id: number;
  sheetId: number;
  label: string;
  autoSaved: boolean;
  createdBy: number;
  actorName: string;
  createdAt: string;
  worksheetCount: number;
  cellCount: number;
}

export interface SheetCellHistoryEntry {
  id: number;
  sheetId: number;
  worksheetId: number;
  row: number;
  col: number;
  prevValue: string;
  nextValue: string;
  prevFormula: string;
  nextFormula: string;
  actorId: number;
  actorName: string;
  createdAt: string;
}

function sheetHistoryHeaders(userId: number): Record<string, string> {
  return {
    "X-Jiange-User-Id": String(userId),
    "X-Jiange-Sheet-Version": "1",
  };
}

async function sheetHistoryRequest<T>(
  method: string,
  path: string,
  userId: number,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers = sheetHistoryHeaders(userId);
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

export const sheetHistoryApi = {
  listVersions: (sheetId: number, userId: number, signal?: AbortSignal) =>
    sheetHistoryRequest<{ versions: SheetVersionMeta[] }>(
      "GET",
      `/api/sheets/${sheetId}/versions`,
      userId,
      undefined,
      signal,
    ),

  createVersion: (sheetId: number, userId: number, label: string) =>
    sheetHistoryRequest<{ version: SheetVersionMeta }>(
      "POST",
      `/api/sheets/${sheetId}/versions`,
      userId,
      { label },
    ),

  restoreVersion: (sheetId: number, userId: number, versionId: number) =>
    sheetHistoryRequest<SheetSnapshot>(
      "POST",
      `/api/sheets/${sheetId}/versions/${versionId}/restore`,
      userId,
    ),

  listCellHistory: (
    sheetId: number,
    userId: number,
    worksheetId: number,
    row: number,
    col: number,
    limit = 50,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({
      worksheetId: String(worksheetId),
      row: String(row),
      col: String(col),
      limit: String(limit),
    });
    return sheetHistoryRequest<{ entries: SheetCellHistoryEntry[] }>(
      "GET",
      `/api/sheets/${sheetId}/cell-history?${params.toString()}`,
      userId,
      undefined,
      signal,
    );
  },
};
