import type { SyncClient } from "@zseven-w/collab";

/** Capture only an acknowledged v2 document head for a named version. */
export function namedVersionPoint(client: Pick<SyncClient, "doc" | "caughtUp" | "status" | "unacked" | "epoch" | "lastSeq" | "blocked" | "droppedOnResync">, canEdit: boolean, verified: boolean): { seq: number; epoch: number } | null {
  const { epoch, lastSeq } = client;
  if (!canEdit || !verified || !client.doc || !client.caughtUp || client.status !== "synced" || client.unacked !== 0 || client.blocked || client.droppedOnResync > 0 || epoch === null) return null;
  if (!Number.isSafeInteger(lastSeq) || lastSeq <= 0 || !Number.isSafeInteger(epoch) || epoch <= 0) return null;
  return { seq: lastSeq, epoch };
}
