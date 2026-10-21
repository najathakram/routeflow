import type { OrderDraftPayload } from "@/lib/drafts";

/**
 * SA-817 (A) 1/6: the local mirror of an in-progress staff order. One record per draft, in IndexedDB under
 * `rf:draft:{tenantId}:{userId}:{localId}`. The store sits behind this small interface so tests use the in-memory adapter
 * (no fake-indexeddb dependency) and a browser without IndexedDB degrades to a no-op (the server draft still works).
 *
 * Privacy (A6): a record holds ids, quantities, staff-typed fields and `customerName` (already on `SaleDraft`), nothing else.
 */
export const DRAFT_MIRROR_PREFIX = "rf:draft:";

export interface LocalDraftRecord {
  localId: string;
  tenantId: string;
  userId: string;
  /** The bound server `SaleDraft`, once one exists. */
  serverDraftId: string | null;
  /** The server draft's `updatedAt` as of our last confirmed sync: the `expectedUpdatedAt` of the next PATCH. */
  serverUpdatedAt: string | null;
  /** `payloadHash` of the payload the server last confirmed (null = never synced). */
  syncedHash: string | null;
  customerId: string | null;
  customerName: string | null;
  /** The full builder state, `_submitKey` included. */
  payload: OrderDraftPayload & Record<string, unknown>;
  /** `payloadHash(payload)`. */
  hash: string;
  /** Device clock, display only ("saved 3 min ago"); never used to decide anything. */
  savedAt: string;
}

export interface DraftMirrorStorage {
  get(key: string): Promise<LocalDraftRecord | null>;
  put(key: string, record: LocalDraftRecord): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every record whose key starts with `prefix`. */
  list(prefix: string): Promise<LocalDraftRecord[]>;
}

export function mirrorKey(tenantId: string, userId: string, localId: string): string {
  return `${DRAFT_MIRROR_PREFIX}${tenantId}:${userId}:${localId}`;
}

/** The prefix that selects exactly one tenant + user's records (A7: never another user's or tenant's). */
export function mirrorPrefix(tenantId: string, userId: string): string {
  return `${DRAFT_MIRROR_PREFIX}${tenantId}:${userId}:`;
}

export function createMemoryDraftStorage(): DraftMirrorStorage & { size(): number } {
  const map = new Map<string, LocalDraftRecord>();
  const clone = (r: LocalDraftRecord): LocalDraftRecord => JSON.parse(JSON.stringify(r));
  return {
    async get(key) {
      const r = map.get(key);
      return r ? clone(r) : null;
    },
    async put(key, record) {
      map.set(key, clone(record));
    },
    async delete(key) {
      map.delete(key);
    },
    async list(prefix) {
      return Array.from(map.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([, r]) => clone(r));
    },
    size: () => map.size,
  };
}

/** Used when the browser has no IndexedDB (private mode, an old WebView, jsdom): nothing is kept, nothing fails. */
export function createNoopDraftStorage(): DraftMirrorStorage {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
  };
}

const DB_NAME = "rf-order-drafts";
const STORE = "drafts";

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export function createIndexedDbDraftStorage(idb: IDBFactory): DraftMirrorStorage {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => (dbPromise ??= openDb(idb));
  const store = async (mode: IDBTransactionMode) =>
    (await db()).transaction(STORE, mode).objectStore(STORE);
  return {
    async get(key) {
      return (
        ((await request((await store("readonly")).get(key))) as LocalDraftRecord | undefined) ??
        null
      );
    },
    async put(key, record) {
      await request((await store("readwrite")).put(record, key));
    },
    async delete(key) {
      await request((await store("readwrite")).delete(key));
    },
    async list(prefix) {
      // keys are strings: a range from the prefix to the prefix + the highest code unit selects exactly the prefix.
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      return (await request((await store("readonly")).getAll(range))) as LocalDraftRecord[];
    },
  };
}

let current: DraftMirrorStorage | null = null;

/** Tests inject the in-memory adapter here; `null` restores the browser default. */
export function setDraftMirrorStorage(storage: DraftMirrorStorage | null): void {
  current = storage;
}

export function getDraftMirrorStorage(): DraftMirrorStorage {
  if (current) return current;
  const idb = typeof indexedDB !== "undefined" ? indexedDB : null;
  current = idb ? createIndexedDbDraftStorage(idb) : createNoopDraftStorage();
  return current;
}
