/** Original Word files are kept locally until the user verifies and clears an import. */
export interface PendingWord { file?: File; name: string; persistent: boolean; missing?: boolean }
const memory = new Map<string, PendingWord>();
const keyFor = (user: number, doc: number) => `${user}:${doc}`;
const markerFor = (key: string) => `jiange:word-import-volatile:${key}`;

async function openStorage(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB unavailable");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("jiange-word-imports", 1);
    let blocked = false;
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("files")) request.result.createObjectStore("files"); };
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => { blocked = true; reject(new Error("IndexedDB blocked")); };
  });
}

async function writeRecord(key: string, value: { blob: Blob; name: string } | null): Promise<void> {
  const db = await openStorage();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      if (value) tx.objectStore("files").put(value, key); else tx.objectStore("files").delete(key);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    });
  } finally { db.close(); }
}

async function readRecord(key: string): Promise<{ blob: Blob; name: string } | undefined> {
  const db = await openStorage();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readonly");
      const request = tx.objectStore("files").get(key);
      request.onsuccess = () => {
        const value: unknown = request.result;
        if (value && typeof value === "object" && (value as { blob?: unknown }).blob instanceof Blob && typeof (value as { name?: unknown }).name === "string") resolve(value as { blob: Blob; name: string });
        else resolve(undefined);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB read aborted"));
    });
  } finally { db.close(); }
}

export async function stagePendingWord(user: number, doc: number, file: File): Promise<PendingWord> {
  const key = keyFor(user, doc);
  const value: PendingWord = { file, name: file.name, persistent: false };
  memory.set(key, value);
  try {
    await writeRecord(key, { blob: file, name: file.name });
    value.persistent = true;
    try { sessionStorage.removeItem(markerFor(key)); } catch { /* no marker needed */ }
  } catch {
    try { sessionStorage.setItem(markerFor(key), file.name); } catch { /* in-memory only */ }
  }
  return value;
}

export async function loadPendingWord(user: number, doc: number): Promise<PendingWord | null> {
  const key = keyFor(user, doc);
  const cached = memory.get(key);
  if (cached) return cached;
  try {
    const name = sessionStorage.getItem(markerFor(key));
    if (name !== null) return { name, persistent: false, missing: true };
  } catch { /* storage unavailable */ }
  if (typeof indexedDB === "undefined") return null;
  try {
    const stored = await readRecord(key);
    if (stored) {
      const value: PendingWord = { file: new File([stored.blob], stored.name, { type: stored.blob.type }), name: stored.name, persistent: true };
      memory.set(key, value);
      return value;
    }
  } catch { throw new Error("无法读取本地 Word 暂存，请检查浏览器存储后重试。"); }
  return null;
}

export async function clearPendingWord(user: number, doc: number, pending: PendingWord): Promise<void> {
  const key = keyFor(user, doc);
  // Also clear an older durable draft when the latest write fell back to
  // memory; otherwise removing the marker could reveal stale content later.
  if (typeof indexedDB !== "undefined") await writeRecord(key, null);
  else if (pending.persistent) throw new Error("IndexedDB unavailable");
  memory.delete(key);
  try { sessionStorage.removeItem(markerFor(key)); } catch { /* best effort */ }
}
