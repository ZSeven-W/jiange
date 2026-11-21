/**
 * Offline Draft Persistence Adapters (`@jiange/collab/storage`) for `Doc` snapshots
 * and unsynced operation logs. Includes in-memory and IndexedDB implementations.
 */

export interface StoredDraft {
  docKey: string;
  snapshot: Uint8Array;
  pendingOps: Uint8Array[];
  updatedAt: number;
}

export interface DraftStorageAdapter {
  save(draft: StoredDraft): Promise<void>;
  load(docKey: string): Promise<StoredDraft | null>;
  delete(docKey: string): Promise<void>;
  listKeys(): Promise<string[]>;
}

/** Deterministic in-memory draft storage (Node.js, Edge, tests). */
export class MemoryDraftStorage implements DraftStorageAdapter {
  private readonly store = new Map<string, StoredDraft>();

  async save(draft: StoredDraft): Promise<void> {
    this.store.set(draft.docKey, {
      docKey: draft.docKey,
      snapshot: draft.snapshot.slice(),
      pendingOps: draft.pendingOps.map((o) => o.slice()),
      updatedAt: draft.updatedAt,
    });
  }

  async load(docKey: string): Promise<StoredDraft | null> {
    const found = this.store.get(docKey);
    if (!found) return null;
    return {
      docKey: found.docKey,
      snapshot: found.snapshot.slice(),
      pendingOps: found.pendingOps.map((o) => o.slice()),
      updatedAt: found.updatedAt,
    };
  }

  async delete(docKey: string): Promise<void> {
    this.store.delete(docKey);
  }

  async listKeys(): Promise<string[]> {
    return [...this.store.keys()].sort();
  }
}

interface IdbRequestLike<T = unknown> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface IdbStoreLike {
  put(value: unknown): IdbRequestLike;
  get(key: string): IdbRequestLike<StoredDraft | undefined>;
  delete(key: string): IdbRequestLike;
  getAllKeys(): IdbRequestLike<unknown[]>;
}

interface IdbDbLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, opts: { keyPath: string }): void;
  transaction(store: string, mode: "readonly" | "readwrite"): { objectStore(name: string): IdbStoreLike };
  close(): void;
}

interface IdbFactoryLike {
  open(name: string, version: number): IdbRequestLike<IdbDbLike> & { onupgradeneeded: (() => void) | null };
}

/** Zero-dependency IndexedDB offline draft storage for browsers. */
export class IndexedDbDraftStorage implements DraftStorageAdapter {
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly factory: IdbFactoryLike;
  private dbPromise: Promise<IdbDbLike> | null = null;

  constructor(options?: { dbName?: string; storeName?: string; indexedDB?: IdbFactoryLike }) {
    this.dbName = options?.dbName ?? "jiange-collab-drafts";
    this.storeName = options?.storeName ?? "drafts";
    const idb = options?.indexedDB ?? (globalThis as unknown as { indexedDB?: IdbFactoryLike }).indexedDB;
    if (!idb) throw new Error("IndexedDB is unavailable in this environment");
    this.factory = idb;
  }

  private openDb(): Promise<IdbDbLike> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IdbDbLike>((resolve, reject) => {
        const req = this.factory.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: "docKey" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
      });
    }
    return this.dbPromise;
  }

  private runReq<T>(req: IdbRequestLike<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
  }

  async save(draft: StoredDraft): Promise<void> {
    const db = await this.openDb();
    const store = db.transaction(this.storeName, "readwrite").objectStore(this.storeName);
    await this.runReq(store.put(draft));
  }

  async load(docKey: string): Promise<StoredDraft | null> {
    const db = await this.openDb();
    const store = db.transaction(this.storeName, "readonly").objectStore(this.storeName);
    const res = await this.runReq(store.get(docKey));
    return res ?? null;
  }

  async delete(docKey: string): Promise<void> {
    const db = await this.openDb();
    const store = db.transaction(this.storeName, "readwrite").objectStore(this.storeName);
    await this.runReq(store.delete(docKey));
  }

  async listKeys(): Promise<string[]> {
    const db = await this.openDb();
    const store = db.transaction(this.storeName, "readonly").objectStore(this.storeName);
    const keys = await this.runReq(store.getAllKeys());
    return keys.map(String).sort();
  }
}
