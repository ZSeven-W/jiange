import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, type Me, type Workspace } from "@/lib/api";

export interface ActiveWorkspaceChange {
  userId: number;
  workspaceId: number | null;
}

export type ActiveWorkspaceListener = (change: ActiveWorkspaceChange) => void;

type WorkspaceReadStorage = Pick<Storage, "getItem">;
type WorkspaceWriteStorage = Pick<Storage, "setItem">;

const ACTIVE_WORKSPACE_KEY_PREFIX = "jiange:active-workspace:v1:";

export const activeWorkspaceStorageKey = (userId: number) => `${ACTIVE_WORKSPACE_KEY_PREFIX}${userId}`;

function browserWorkspaceStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parsePositiveWorkspaceId(raw: string | null): number | null {
  if (!raw || !/^[1-9]\d*$/.test(raw.trim())) return null;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const listeners = new Set<ActiveWorkspaceListener>();
let storageListenerAttached = false;

function notifyListeners(change: ActiveWorkspaceChange) {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch {
      // Keep remaining subscribers synchronized even if one throws.
    }
  }
}

function handleWindowStorage(event: StorageEvent) {
  if (event.key === null) {
    notifyListeners({ userId: 0, workspaceId: null });
    return;
  }
  if (!event.key.startsWith(ACTIVE_WORKSPACE_KEY_PREFIX)) return;
  const uidRaw = event.key.slice(ACTIVE_WORKSPACE_KEY_PREFIX.length);
  const userId = parsePositiveWorkspaceId(uidRaw);
  if (!userId) return;
  notifyListeners({
    userId,
    workspaceId: parsePositiveWorkspaceId(event.newValue),
  });
}

function syncWindowStorageListener() {
  if (typeof window === "undefined") return;
  if (listeners.size > 0 && !storageListenerAttached) {
    window.addEventListener("storage", handleWindowStorage);
    storageListenerAttached = true;
  } else if (listeners.size === 0 && storageListenerAttached) {
    window.removeEventListener("storage", handleWindowStorage);
    storageListenerAttached = false;
  }
}

/**
 * Returns the persisted active workspace ID for `userId` when it still belongs
 * to `workspaces`; otherwise falls back to the first workspace (or null).
 */
export function getActiveWorkspaceId(
  userId: number,
  workspaces: readonly Workspace[],
  storage: WorkspaceReadStorage | null = browserWorkspaceStorage(),
): number | null {
  if (!workspaces.length) return null;
  if (Number.isSafeInteger(userId) && userId > 0) {
    try {
      const stored = parsePositiveWorkspaceId(storage?.getItem(activeWorkspaceStorageKey(userId)) ?? null);
      if (stored !== null && workspaces.some((w) => w.id === stored)) {
        return stored;
      }
    } catch {
      // Storage may be blocked in sandboxed or private browsing contexts.
    }
  }
  return workspaces[0]?.id ?? null;
}

/**
 * Persists the user's selected workspace ID and notifies all in-tab listeners.
 */
export function setActiveWorkspaceId(
  userId: number,
  wsId: number,
  storage: WorkspaceWriteStorage | null = browserWorkspaceStorage(),
): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  if (!Number.isSafeInteger(wsId) || wsId <= 0) return;
  try {
    storage?.setItem(activeWorkspaceStorageKey(userId), String(wsId));
  } catch {
    // Keep same-tab listeners working even when localStorage writes fail.
  }
  notifyListeners({ userId, workspaceId: wsId });
}

/**
 * Subscribes to active workspace switches across the current tab and other tabs.
 */
export function subscribeActiveWorkspace(listener: ActiveWorkspaceListener): () => void {
  listeners.add(listener);
  syncWindowStorageListener();
  return () => {
    listeners.delete(listener);
    syncWindowStorageListener();
  };
}

/**
 * React hook exposing the user's currently active workspace and a persistent switcher.
 */
export function useActiveWorkspace(me: Pick<Me, "user" | "workspaces"> | null | undefined): {
  activeWorkspace: Workspace | null;
  activeWorkspaceId: number | null;
  setActiveWorkspace: (wsId: number) => void;
} {
  const userId = me?.user.id ?? 0;
  const workspaces = me?.workspaces ?? [];
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!userId) return;
    return subscribeActiveWorkspace((change) => {
      if (change.userId === 0 || change.userId === userId) {
        setVersion((v) => v + 1);
      }
    });
  }, [userId]);

  const activeWorkspaceId = userId ? getActiveWorkspaceId(userId, workspaces) : null;
  const activeWorkspace = useMemo(
    () => (activeWorkspaceId == null ? null : workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null),
    [activeWorkspaceId, workspaces],
  );

  const setActiveWorkspace = useCallback(
    (wsId: number) => {
      if (!userId) return;
      setActiveWorkspaceId(userId, wsId);
    },
    [userId],
  );

  return { activeWorkspace, activeWorkspaceId, setActiveWorkspace };
}

async function workspaceRequest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) {
    return undefined as T;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { error?: string }).error ?? "error",
      (data as { message?: string }).message ?? res.statusText,
      data as Record<string, unknown>,
    );
  }
  return data as T;
}

export async function renameWorkspace(wsId: number, name: string): Promise<Workspace> {
  const data = await workspaceRequest<{ workspace: Workspace }>("PATCH", `/api/workspaces/${wsId}`, { name });
  return data.workspace;
}

export async function deleteWorkspace(wsId: number): Promise<void> {
  await workspaceRequest<void>("DELETE", `/api/workspaces/${wsId}`);
}

export async function transferWorkspaceOwner(wsId: number, targetUserId: number): Promise<void> {
  await workspaceRequest<void>("POST", `/api/workspaces/${wsId}/transfer-owner`, { targetUserId });
}

export async function leaveWorkspace(wsId: number): Promise<void> {
  await workspaceRequest<void>("POST", `/api/workspaces/${wsId}/leave`);
}

export const workspacesApi = {
  list: async (): Promise<Workspace[]> => {
    const data = await workspaceRequest<{ workspaces?: Workspace[] }>("GET", "/api/workspaces");
    return Array.isArray(data.workspaces) ? data.workspaces : [];
  },

  create: async (name: string): Promise<Workspace> => {
    const data = await workspaceRequest<{ workspace: Workspace }>("POST", "/api/workspaces", { name });
    return data.workspace;
  },

  rename: renameWorkspace,
  delete: deleteWorkspace,
  transferOwner: transferWorkspaceOwner,
  leave: leaveWorkspace,
};
