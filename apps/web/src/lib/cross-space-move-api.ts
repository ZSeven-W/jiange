import { ApiError, type DriveEntry } from "@/lib/api";

export interface CrossSpaceMoveInput {
  nodeId: number;
  targetWorkspaceId?: number;
  targetParentId: number | null;
  targetPersonal: boolean;
  expected: number;
  userId: number;
}

export interface CrossSpaceMoveResponse {
  entry: DriveEntry;
}

export const crossSpaceMoveApi = {
  move: async (input: CrossSpaceMoveInput): Promise<DriveEntry> => {
    const res = await fetch(`/api/drive/cross-space-move/${input.nodeId}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Jiange-User-Id": String(input.userId),
      },
      body: JSON.stringify({
        ...(input.targetWorkspaceId && input.targetWorkspaceId > 0
          ? { targetWorkspaceId: input.targetWorkspaceId }
          : {}),
        targetParentId: input.targetParentId,
        targetPersonal: input.targetPersonal,
        expected: input.expected,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(
        res.status,
        (data as { error?: string }).error ?? "error",
        (data as { message?: string }).message ?? res.statusText,
        data as Record<string, unknown>,
      );
    }
    return (data as CrossSpaceMoveResponse).entry;
  },
};
