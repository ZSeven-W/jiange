/**
 * Zero-dependency IndexedDB offline persistence layer (`jiange-offline-v1`)
 * with transparent in-memory fallback when IndexedDB is unavailable
 * (SSR, Node tests, jsdom, or restricted browser private mode).
 *
 * Security rule: sensitive auth, MFA, PAT, SSO, and webhook secret endpoints
 * are strictly excluded via `isCacheableOfflinePath()`.
 */

export const OFFLINE_DB_NAME = "jiange-offline-v1";
export const OFFLINE_DB_VERSION = 2;
export const OFFLINE_SNAPSHOTS_STORE = "snapshots";
export const OFFLINE_QUEUE_STORE = "queue";
export const OFFLINE_COLLAB_STORE = "collab_replicas";

export const MAX_OFFLINE_SNAPSHOTS = 50;
export const MAX_OFFLINE_SNAPSHOT_BYTES = 16 * 1024 * 1024; // 16 MB

export type OfflineSnapshotKind = "doc" | "sheet" | "base" | "slides" | "list";

export interface OfflineSnapshot {
  key: string;
  kind: OfflineSnapshotKind;
  resourceId?: number;
  title: string;
  data: unknown;
  updatedAt: number;
  sizeBytes: number;
}

export interface CacheOfflineSnapshotInput {
  key: string;
  kind: OfflineSnapshotKind;
  resourceId?: number;
  title: string;
  data: unknown;
  updatedAt?: number;
  /** Optional precomputed byte size (auto-calculated from JSON UTF-8 length if omitted). */
  sizeBytes?: number;
}

export type OfflineMutationResourceType = "doc" | "sheet" | "base" | "slides" | "other";
export type OfflineMutationMethod = "POST" | "PATCH" | "PUT" | "DELETE";

export interface OfflineMutation {
  id: string;
  resourceType: OfflineMutationResourceType;
  resourceId?: number;
  title: string;
  method: OfflineMutationMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  createdAt: number;
  retries: number;
  lastError?: string;
}

export interface EnqueueOfflineMutationInput {
  id?: string;
  resourceType: OfflineMutationResourceType;
  resourceId?: number;
  title: string;
  method: OfflineMutationMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  createdAt?: number;
  retries?: number;
  lastError?: string;
}

export interface DocCollabReplica {
  key: string;
  kind: "doc";
  userId: number;
  docId: number;
  snapshotBase64: string;
  seq: number;
  historyEpoch: number | null;
  role: "view" | "edit" | "manage";
  clientId?: number;
  updatedAt: number;
  pendingOpsCount: number;
}

export interface SheetOfflineCellEdit {
  worksheetId?: number;
  row: number;
  col: number;
  rowId?: number;
  columnId?: number;
  raw: string;
  expectedRevision?: number;
  updatedAt: number;
}

export interface SheetOfflineDelta {
  key: string;
  kind: "sheet";
  userId: number;
  sheetId: number;
  worksheetId: number;
  edits: SheetOfflineCellEdit[];
  baseRevision: number;
  updatedAt: number;
}

export interface SlidesOfflinePageEntry {
  pageId: number;
  shapesJson: string;
  baseRevision: number;
  title?: string;
  body?: string;
  background?: string;
  layout?: string;
  notes?: string;
  updatedAt: number;
}

export interface SlidesOfflineDraft {
  key: string;
  kind: "slides";
  userId: number;
  deckId: number;
  pageId: number;
  shapesJson: string;
  baseRevision: number;
  title?: string;
  body?: string;
  background?: string;
  layout?: string;
  notes?: string;
  pages?: Record<string, SlidesOfflinePageEntry>;
  updatedAt: number;
}

export type OfflineCollabRecord = DocCollabReplica | SheetOfflineDelta | SlidesOfflineDraft;
export type OfflineCollabRecordKind = OfflineCollabRecord["kind"];

export interface OfflineStorageStats {
  snapshotCount: number;
  totalBytes: number;
  queueCount: number;
  collabCount: number;
  maxSnapshots: number;
  maxBytes: number;
  backend: "indexeddb" | "memory";
}

const SENSITIVE_PATH_PREFIXES = [
  "/api/auth",
  "/api/sso",
  "/api/me/tokens",
  "/api/me/mfa",
  "/api/me/password",
  "/api/me/sessions",
  "/api/me/security",
] as const;

const SENSITIVE_SEGMENT_PATTERN =
  /^(auth|mfa|totp|tokens?|secrets?|webhooks?|sso|oauth2?|oidc|scim|org-sync|sync-sources|passwords?|credentials?|api-?keys?|pat|share-password)$/i;

const SENSITIVE_KEY_PATTERN =
  /(^|[:/])(auth|mfa|totp|tokens?|secrets?|webhooks?|sso|oauth2?|oidc|scim|passwords?|credentials?)($|[:/])/i;

const FORBIDDEN_PERSISTED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
]);

function decodePathSafely(rawPath: string): string | null {
  let current = rawPath;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      return null;
    }
  }
  return current;
}

/**
 * Pure security guard: returns `true` ONLY for non-sensitive `/api/*` paths
 * safe to persist in offline storage or replay from the offline mutation queue.
 *
 * Strictly rejects `/api/me/tokens`, `/api/me/mfa`, `/api/auth/*`, SSO/SCIM,
 * password, credential, and webhook secret endpoints.
 */
export function isCacheableOfflinePath(path: string): boolean {
  if (typeof path !== "string") return false;
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("\0")) return false;

  let pathname: string;
  if (trimmed.startsWith("/")) {
    try {
      pathname = new URL(trimmed, "https://jiange.local").pathname;
    } catch {
      return false;
    }
  } else if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      pathname = parsed.pathname;
    } catch {
      return false;
    }
  } else {
    return false;
  }

  const decoded = decodePathSafely(pathname);
  if (!decoded || decoded.includes("\0")) return false;

  const normalized = decoded.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  const lower = normalized.toLowerCase();

  if (lower !== "/api" && !lower.startsWith("/api/")) {
    return false;
  }
  if (lower === "/api") {
    return false;
  }

  const segments = lower.split("/").filter(Boolean);
  if (segments.some((seg) => seg === "." || seg === "..")) {
    return false;
  }

  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) {
      return false;
    }
  }

  // Inspect segments after `/api/`
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (
      SENSITIVE_SEGMENT_PATTERN.test(seg) ||
      seg.includes("secret") ||
      seg.includes("password") ||
      seg.includes("webhook")
    ) {
      return false;
    }
  }

  return true;
}

function isSafeSnapshotKey(key: string): boolean {
  if (typeof key !== "string") return false;
  const trimmed = key.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || /^https?:\/\//i.test(trimmed)) {
    return isCacheableOfflinePath(trimmed);
  }
  return !SENSITIVE_KEY_PATTERN.test(trimmed);
}

function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(headers)) {
    if (!k || typeof v !== "string") continue;
    if (FORBIDDEN_PERSISTED_HEADERS.has(k.toLowerCase())) continue;
    result[k] = v;
    count++;
  }
  return count > 0 ? result : undefined;
}

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // fall through to JSON clone
    }
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export function estimateOfflineBytes(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    serialized = String(value ?? "");
  }
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(serialized).byteLength;
  }
  return serialized.length * 2;
}

interface OfflineDbBackend {
  readonly kind: "indexeddb" | "memory";
  getSnapshot(key: string): Promise<OfflineSnapshot | null>;
  getAllSnapshots(): Promise<OfflineSnapshot[]>;
  putSnapshot(snapshot: OfflineSnapshot): Promise<void>;
  deleteSnapshot(key: string): Promise<void>;
  deleteSnapshots(keys: string[]): Promise<void>;
  clearSnapshots(): Promise<void>;
  getMutation(id: string): Promise<OfflineMutation | null>;
  getAllMutations(): Promise<OfflineMutation[]>;
  putMutation(mutation: OfflineMutation): Promise<void>;
  deleteMutation(id: string): Promise<void>;
  clearMutations(): Promise<void>;
  getCollabRecord(key: string): Promise<OfflineCollabRecord | null>;
  getAllCollabRecords(): Promise<OfflineCollabRecord[]>;
  putCollabRecord(record: OfflineCollabRecord): Promise<void>;
  deleteCollabRecord(key: string): Promise<void>;
  clearCollabRecords(): Promise<void>;
  close(): void;
}

function createMemoryBackend(): OfflineDbBackend {
  const snapshots = new Map<string, OfflineSnapshot>();
  const queue = new Map<string, OfflineMutation>();
  const collab = new Map<string, OfflineCollabRecord>();

  return {
    kind: "memory",
    async getSnapshot(key) {
      const item = snapshots.get(key);
      return item ? cloneValue(item) : null;
    },
    async getAllSnapshots() {
      return Array.from(snapshots.values(), (item) => cloneValue(item));
    },
    async putSnapshot(snapshot) {
      snapshots.set(snapshot.key, cloneValue(snapshot));
    },
    async deleteSnapshot(key) {
      snapshots.delete(key);
    },
    async deleteSnapshots(keys) {
      for (const key of keys) snapshots.delete(key);
    },
    async clearSnapshots() {
      snapshots.clear();
    },
    async getMutation(id) {
      const item = queue.get(id);
      return item ? cloneValue(item) : null;
    },
    async getAllMutations() {
      return Array.from(queue.values(), (item) => cloneValue(item));
    },
    async putMutation(mutation) {
      queue.set(mutation.id, cloneValue(mutation));
    },
    async deleteMutation(id) {
      queue.delete(id);
    },
    async clearMutations() {
      queue.clear();
    },
    async getCollabRecord(key) {
      const item = collab.get(key);
      return item ? cloneValue(item) : null;
    },
    async getAllCollabRecords() {
      return Array.from(collab.values(), (item) => cloneValue(item));
    },
    async putCollabRecord(record) {
      collab.set(record.key, cloneValue(record));
    },
    async deleteCollabRecord(key) {
      collab.delete(key);
    },
    async clearCollabRecords() {
      collab.clear();
    },
    close() {
      snapshots.clear();
      queue.clear();
      collab.clear();
    },
  };
}

function idbRequestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function idbTransactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function createIndexedDbBackend(db: IDBDatabase): OfflineDbBackend {
  return {
    kind: "indexeddb",
    async getSnapshot(key) {
      const tx = db.transaction(OFFLINE_SNAPSHOTS_STORE, "readonly");
      const result = await idbRequestToPromise(
        tx.objectStore(OFFLINE_SNAPSHOTS_STORE).get(key) as IDBRequest<OfflineSnapshot | undefined>,
      );
      return result ?? null;
    },
    async getAllSnapshots() {
      const tx = db.transaction(OFFLINE_SNAPSHOTS_STORE, "readonly");
      const result = await idbRequestToPromise(
        tx.objectStore(OFFLINE_SNAPSHOTS_STORE).getAll() as IDBRequest<OfflineSnapshot[]>,
      );
      return Array.isArray(result) ? result : [];
    },
    async putSnapshot(snapshot) {
      const tx = db.transaction(OFFLINE_SNAPSHOTS_STORE, "readwrite");
      tx.objectStore(OFFLINE_SNAPSHOTS_STORE).put(snapshot);
      await idbTransactionComplete(tx);
    },
    async deleteSnapshot(key) {
      const tx = db.transaction(OFFLINE_SNAPSHOTS_STORE, "readwrite");
      tx.objectStore(OFFLINE_SNAPSHOTS_STORE).delete(key);
      await idbTransactionComplete(tx);
    },
    async deleteSnapshots(keys) {
      if (keys.length === 0) return;
      const tx = db.transaction(OFFLINE_SNAPSHOTS_STORE, "readwrite");
      const store = tx.objectStore(OFFLINE_SNAPSHOTS_STORE);
      for (const key of keys) {
        store.delete(key);
      }
      await idbTransactionComplete(tx);
    },
    async clearSnapshots() {
      const tx = db.transaction(OFFLINE_SNAPSHOTS_STORE, "readwrite");
      tx.objectStore(OFFLINE_SNAPSHOTS_STORE).clear();
      await idbTransactionComplete(tx);
    },
    async getMutation(id) {
      const tx = db.transaction(OFFLINE_QUEUE_STORE, "readonly");
      const result = await idbRequestToPromise(
        tx.objectStore(OFFLINE_QUEUE_STORE).get(id) as IDBRequest<OfflineMutation | undefined>,
      );
      return result ?? null;
    },
    async getAllMutations() {
      const tx = db.transaction(OFFLINE_QUEUE_STORE, "readonly");
      const result = await idbRequestToPromise(
        tx.objectStore(OFFLINE_QUEUE_STORE).getAll() as IDBRequest<OfflineMutation[]>,
      );
      return Array.isArray(result) ? result : [];
    },
    async putMutation(mutation) {
      const tx = db.transaction(OFFLINE_QUEUE_STORE, "readwrite");
      tx.objectStore(OFFLINE_QUEUE_STORE).put(mutation);
      await idbTransactionComplete(tx);
    },
    async deleteMutation(id) {
      const tx = db.transaction(OFFLINE_QUEUE_STORE, "readwrite");
      tx.objectStore(OFFLINE_QUEUE_STORE).delete(id);
      await idbTransactionComplete(tx);
    },
    async clearMutations() {
      const tx = db.transaction(OFFLINE_QUEUE_STORE, "readwrite");
      tx.objectStore(OFFLINE_QUEUE_STORE).clear();
      await idbTransactionComplete(tx);
    },
    async getCollabRecord(key) {
      const tx = db.transaction(OFFLINE_COLLAB_STORE, "readonly");
      const result = await idbRequestToPromise(
        tx.objectStore(OFFLINE_COLLAB_STORE).get(key) as IDBRequest<OfflineCollabRecord | undefined>,
      );
      return result ?? null;
    },
    async getAllCollabRecords() {
      const tx = db.transaction(OFFLINE_COLLAB_STORE, "readonly");
      const result = await idbRequestToPromise(
        tx.objectStore(OFFLINE_COLLAB_STORE).getAll() as IDBRequest<OfflineCollabRecord[]>,
      );
      return Array.isArray(result) ? result : [];
    },
    async putCollabRecord(record) {
      const tx = db.transaction(OFFLINE_COLLAB_STORE, "readwrite");
      tx.objectStore(OFFLINE_COLLAB_STORE).put(record);
      await idbTransactionComplete(tx);
    },
    async deleteCollabRecord(key) {
      const tx = db.transaction(OFFLINE_COLLAB_STORE, "readwrite");
      tx.objectStore(OFFLINE_COLLAB_STORE).delete(key);
      await idbTransactionComplete(tx);
    },
    async clearCollabRecords() {
      const tx = db.transaction(OFFLINE_COLLAB_STORE, "readwrite");
      tx.objectStore(OFFLINE_COLLAB_STORE).clear();
      await idbTransactionComplete(tx);
    },
    close() {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    },
  };
}

function openIndexedDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOTS_STORE)) {
        const snapStore = db.createObjectStore(OFFLINE_SNAPSHOTS_STORE, { keyPath: "key" });
        if (typeof snapStore.createIndex === "function") {
          snapStore.createIndex("by_updatedAt", "updatedAt", { unique: false });
          snapStore.createIndex("by_kind", "kind", { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(OFFLINE_QUEUE_STORE)) {
        const queueStore = db.createObjectStore(OFFLINE_QUEUE_STORE, { keyPath: "id" });
        if (typeof queueStore.createIndex === "function") {
          queueStore.createIndex("by_createdAt", "createdAt", { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(OFFLINE_COLLAB_STORE)) {
        const collabStore = db.createObjectStore(OFFLINE_COLLAB_STORE, { keyPath: "key" });
        if (typeof collabStore.createIndex === "function") {
          collabStore.createIndex("by_updatedAt", "updatedAt", { unique: false });
          collabStore.createIndex("by_kind", "kind", { unique: false });
          collabStore.createIndex("by_userId", "userId", { unique: false });
        }
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

let customIdbFactory: IDBFactory | null | undefined;
let backendPromise: Promise<OfflineDbBackend> | null = null;
let lastMutationCreatedAt = 0;
let mutationSequence = 0;
const dbChangeListeners = new Set<() => void>();

function emitDbChange(): void {
  for (const listener of dbChangeListeners) {
    try {
      listener();
    } catch {
      // keep listeners isolated
    }
  }
}

/**
 * Subscribe to any mutation made to the offline snapshots or mutation queue stores.
 */
export function subscribeOfflineDbChanges(listener: () => void): () => void {
  dbChangeListeners.add(listener);
  return () => {
    dbChangeListeners.delete(listener);
  };
}

function resolveIdbFactory(): IDBFactory | null {
  if (customIdbFactory !== undefined) {
    return customIdbFactory;
  }
  if (typeof globalThis === "undefined") {
    return null;
  }
  try {
    const candidate = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    return candidate && typeof candidate.open === "function" ? candidate : null;
  } catch {
    // Accessing globalThis.indexedDB can throw SecurityError in restricted iframes/private mode
    return null;
  }
}

function getBackend(): Promise<OfflineDbBackend> {
  if (!backendPromise) {
    backendPromise = (async () => {
      const factory = resolveIdbFactory();
      if (!factory) {
        return createMemoryBackend();
      }
      try {
        const db = await openIndexedDb(factory);
        db.onversionchange = () => {
          db.close();
          backendPromise = null;
        };
        return createIndexedDbBackend(db);
      } catch {
        return createMemoryBackend();
      }
    })();
  }
  return backendPromise;
}

/**
 * Test helper to reset the singleton DB connection and optionally inject a custom
 * `IDBFactory` (or `null` to force in-memory fallback).
 */
export async function resetOfflineDbForTesting(options?: {
  indexedDB?: IDBFactory | null;
}): Promise<void> {
  if (backendPromise) {
    try {
      const existing = await backendPromise;
      existing.close();
    } catch {
      // ignore
    }
  }
  backendPromise = null;
  customIdbFactory = options && "indexedDB" in options ? options.indexedDB : undefined;
  lastMutationCreatedAt = 0;
  mutationSequence = 0;
}

async function pruneSnapshotsIfNeeded(
  backend: OfflineDbBackend,
  protectedKey: string,
): Promise<void> {
  const all = await backend.getAllSnapshots();
  let totalBytes = all.reduce((sum, item) => sum + Math.max(0, item.sizeBytes), 0);
  if (all.length <= MAX_OFFLINE_SNAPSHOTS && totalBytes <= MAX_OFFLINE_SNAPSHOT_BYTES) {
    return;
  }

  // LRU eviction order: oldest `updatedAt` first; keep the newly written key if possible.
  const evictionCandidates = all
    .filter((item) => item.key !== protectedKey)
    .sort((a, b) => a.updatedAt - b.updatedAt || a.key.localeCompare(b.key));

  const keysToDelete: string[] = [];
  let remainingCount = all.length;

  for (const candidate of evictionCandidates) {
    if (remainingCount <= MAX_OFFLINE_SNAPSHOTS && totalBytes <= MAX_OFFLINE_SNAPSHOT_BYTES) {
      break;
    }
    keysToDelete.push(candidate.key);
    remainingCount -= 1;
    totalBytes -= Math.max(0, candidate.sizeBytes);
  }

  if (keysToDelete.length > 0) {
    await backend.deleteSnapshots(keysToDelete);
  }
}

/**
 * Cache an offline snapshot with automatic LRU pruning (max 50 entries, max 16 MB total).
 * Returns `null` if the key is blocked by security policy or the single payload exceeds 16 MB.
 */
export async function cacheOfflineSnapshot(
  input: CacheOfflineSnapshotInput,
): Promise<OfflineSnapshot | null> {
  if (!isSafeSnapshotKey(input.key)) {
    return null;
  }

  const normalizedTitle = input.title.trim() || input.key;
  const updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
      ? input.updatedAt
      : Date.now();
  const dataClone = cloneValue(input.data);
  const computedBytes =
    typeof input.sizeBytes === "number" && Number.isSafeInteger(input.sizeBytes) && input.sizeBytes > 0
      ? input.sizeBytes
      : estimateOfflineBytes({
          key: input.key,
          kind: input.kind,
          resourceId: input.resourceId,
          title: normalizedTitle,
          data: dataClone,
        });

  if (computedBytes > MAX_OFFLINE_SNAPSHOT_BYTES) {
    return null;
  }

  const snapshot: OfflineSnapshot = {
    key: input.key,
    kind: input.kind,
    ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
    title: normalizedTitle,
    data: dataClone,
    updatedAt,
    sizeBytes: computedBytes,
  };

  const backend = await getBackend();
  await backend.putSnapshot(snapshot);
  await pruneSnapshotsIfNeeded(backend, snapshot.key);
  emitDbChange();
  return snapshot;
}

export async function getOfflineSnapshot(key: string): Promise<OfflineSnapshot | null> {
  if (!key) return null;
  const backend = await getBackend();
  return backend.getSnapshot(key);
}

/**
 * Returns all cached snapshots ordered most-recently-updated first.
 */
export async function listOfflineSnapshots(): Promise<OfflineSnapshot[]> {
  const backend = await getBackend();
  const all = await backend.getAllSnapshots();
  return all.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
}

export async function deleteOfflineSnapshot(key: string): Promise<void> {
  if (!key) return;
  const backend = await getBackend();
  await backend.deleteSnapshot(key);
  emitDbChange();
}

export async function clearOfflineSnapshots(): Promise<void> {
  const backend = await getBackend();
  await backend.clearSnapshots();
  emitDbChange();
}

export async function offlineStorageStats(): Promise<OfflineStorageStats> {
  const backend = await getBackend();
  const [snapshots, queue, collab] = await Promise.all([
    backend.getAllSnapshots(),
    backend.getAllMutations(),
    backend.getAllCollabRecords(),
  ]);
  const totalBytes = snapshots.reduce((sum, item) => sum + Math.max(0, item.sizeBytes), 0);
  return {
    snapshotCount: snapshots.length,
    totalBytes,
    queueCount: queue.length,
    collabCount: collab.length,
    maxSnapshots: MAX_OFFLINE_SNAPSHOTS,
    maxBytes: MAX_OFFLINE_SNAPSHOT_BYTES,
    backend: backend.kind,
  };
}

function generateMutationId(createdAt: number, seq: number): string {
  const seqStr = String(seq).padStart(6, "0");
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `mut_${createdAt}_${seqStr}_${rand}`;
}

/**
 * Enqueue a mutation for FIFO replay once connectivity returns.
 * Refuses sensitive auth/secret paths and strips sensitive headers.
 */
export async function enqueueOfflineMutation(
  input: EnqueueOfflineMutationInput,
): Promise<OfflineMutation> {
  if (!isCacheableOfflinePath(input.path)) {
    throw new Error(`Refusing to persist sensitive or non-API offline mutation path: ${input.path}`);
  }

  let createdAt: number;
  if (typeof input.createdAt === "number" && Number.isFinite(input.createdAt)) {
    createdAt = input.createdAt;
  } else {
    const now = Date.now();
    createdAt = now > lastMutationCreatedAt ? now : lastMutationCreatedAt + 1;
    lastMutationCreatedAt = createdAt;
  }
  mutationSequence += 1;

  const id = input.id?.trim() || generateMutationId(createdAt, mutationSequence);
  const sanitizedHeaders = sanitizeHeaders(input.headers);
  const mutation: OfflineMutation = {
    id,
    resourceType: input.resourceType,
    ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
    title: input.title.trim() || input.path,
    method: input.method,
    path: input.path,
    ...(input.body !== undefined ? { body: cloneValue(input.body) } : {}),
    ...(sanitizedHeaders ? { headers: sanitizedHeaders } : {}),
    createdAt,
    retries:
      typeof input.retries === "number" && Number.isSafeInteger(input.retries) && input.retries >= 0
        ? input.retries
        : 0,
    ...(input.lastError ? { lastError: input.lastError } : {}),
  };

  const backend = await getBackend();
  await backend.putMutation(mutation);
  emitDbChange();
  return mutation;
}

/**
 * Returns queued mutations sorted strictly in FIFO order (`createdAt` ascending).
 */
export async function listOfflineQueue(): Promise<OfflineMutation[]> {
  const backend = await getBackend();
  const all = await backend.getAllMutations();
  return all.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export async function removeOfflineMutation(id: string): Promise<void> {
  if (!id) return;
  const backend = await getBackend();
  await backend.deleteMutation(id);
  emitDbChange();
}

export async function updateOfflineMutationError(
  id: string,
  lastError: string,
  options?: { incrementRetries?: boolean },
): Promise<OfflineMutation | null> {
  if (!id) return null;
  const backend = await getBackend();
  const existing = await backend.getMutation(id);
  if (!existing) return null;

  const increment = options?.incrementRetries ?? true;
  const updated: OfflineMutation = {
    ...existing,
    retries: increment ? existing.retries + 1 : existing.retries,
    lastError,
  };
  await backend.putMutation(updated);
  emitDbChange();
  return updated;
}

export async function clearOfflineQueue(): Promise<void> {
  const backend = await getBackend();
  await backend.clearMutations();
  emitDbChange();
}

/**
 * Persist a CRDT document replica or offline Sheet/Slides delta in `collab_replicas`.
 * Enforces key safety and the 16 MB per-record size cap.
 */
export async function putOfflineCollabRecord<T extends OfflineCollabRecord>(
  record: T,
): Promise<T | null> {
  if (!isSafeSnapshotKey(record.key)) {
    return null;
  }
  const cloned = cloneValue(record);
  const sizeBytes = estimateOfflineBytes(cloned);
  if (sizeBytes > MAX_OFFLINE_SNAPSHOT_BYTES) {
    return null;
  }
  const backend = await getBackend();
  await backend.putCollabRecord(cloned);
  emitDbChange();
  return cloned;
}

export async function getOfflineCollabRecord<
  T extends OfflineCollabRecord = OfflineCollabRecord,
>(key: string): Promise<T | null> {
  if (!key) return null;
  const backend = await getBackend();
  const record = await backend.getCollabRecord(key);
  return (record as T | null) ?? null;
}

/**
 * List persisted CRDT replicas and offline deltas ordered most-recently-updated first.
 */
export async function listOfflineCollabRecords<
  T extends OfflineCollabRecord = OfflineCollabRecord,
>(kind?: OfflineCollabRecordKind): Promise<T[]> {
  const backend = await getBackend();
  const all = await backend.getAllCollabRecords();
  const filtered = kind ? all.filter((item) => item.kind === kind) : all;
  return filtered
    .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)) as T[];
}

export async function deleteOfflineCollabRecord(key: string): Promise<void> {
  if (!key) return;
  const backend = await getBackend();
  await backend.deleteCollabRecord(key);
  emitDbChange();
}

export async function clearOfflineCollabRecords(kind?: OfflineCollabRecordKind): Promise<void> {
  const backend = await getBackend();
  if (!kind) {
    await backend.clearCollabRecords();
    emitDbChange();
    return;
  }
  const all = await backend.getAllCollabRecords();
  for (const item of all) {
    if (item.kind === kind) {
      await backend.deleteCollabRecord(item.key);
    }
  }
  emitDbChange();
}
