/** A pending import is scoped to the signed-in user and survives page reloads in this tab. */
export interface PendingStarter { markdown: string; persistent: boolean; }
const pending = new Map<string, PendingStarter>();
const keyFor = (ownerId: number, docId: number) => `jiange:starter:${ownerId}:${docId}`;
export function stageStarter(ownerId: number, docId: number, markdown: string): boolean {
  const key = keyFor(ownerId, docId);
  let persistent = false;
  try { sessionStorage.setItem(key, markdown); persistent = true; } catch { /* keep a memory fallback and warn */ }
  pending.set(key, { markdown, persistent });
  return persistent;
}
export function peekStarter(ownerId: number, docId: number): PendingStarter | undefined {
  const key = keyFor(ownerId, docId);
  const cached = pending.get(key);
  if (cached) return cached;
  try {
    const markdown = sessionStorage.getItem(key);
    if (markdown !== null) { const value = { markdown, persistent: true }; pending.set(key, value); return value; }
  } catch { /* storage unavailable */ }
  return undefined;
}
export function takeStarter(ownerId: number, docId: number): PendingStarter | undefined {
  const key = keyFor(ownerId, docId);
  const value = peekStarter(ownerId, docId);
  pending.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ }
  return value;
}
