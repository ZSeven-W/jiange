import type { SyncStatus } from "@jiange/collab";

export interface ImageFailure { version: number; status: SyncStatus }

/** Retry only after a new document version or the pending write is confirmed. */
export function shouldRetryImage(failure: ImageFailure, version: number, status: SyncStatus, attempts: number): boolean {
  return attempts < 2 && status === "synced" && (version > failure.version || failure.status !== "synced");
}
