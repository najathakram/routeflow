import type { OrderDraftPayload } from "@/lib/drafts";
import { payloadHash } from "./payload-hash";
import { mirrorKey, mirrorPrefix, type DraftMirrorStorage, type LocalDraftRecord } from "./storage";

/**
 * SA-817 (A) 1: the local mirror writer. Every change to a parkable order is written to the local store after a 300 ms debounce
 * (`LOCAL_MIRROR_MS`) and flushed at once when the page is hidden or unloading, so a dropped connection, a reload or a killed tab
 * never loses the order. The server PATCH follows when online (the autosave engine).
 *
 * One rule decides whether a record exists: it exists iff its payload differs from what the server last CONFIRMED
 * (`syncedHash`). A write whose hash equals `syncedHash` deletes the record (A6 7: "deleted once the server holds an identical
 * payload hash"); a record the server does not hold is never auto-deleted.
 */
export const LOCAL_MIRROR_MS = 300;

export interface MirrorWriteInput {
  localId: string;
  serverDraftId: string | null;
  serverUpdatedAt: string | null;
  syncedHash: string | null;
  customerId: string | null;
  customerName: string | null;
  payload: OrderDraftPayload & Record<string, unknown>;
}

export interface DraftMirror {
  /** Debounced write of the latest state of one draft (a record the server already holds is deleted instead). */
  write(input: MirrorWriteInput): void;
  /** Persist whatever is pending now (visibilitychange / pagehide / unmount). */
  flush(): Promise<void>;
  /** The order is submitted or discarded: cancel anything pending and delete the record. */
  remove(localId: string): Promise<void>;
  /** This tenant + user's records only (A7). */
  list(): Promise<LocalDraftRecord[]>;
  dispose(): void;
}

export function createDraftMirror(opts: {
  storage: DraftMirrorStorage;
  tenantId: string;
  userId: string;
  debounceMs?: number;
  now?: () => Date;
  onError?: (err: unknown) => void;
}): DraftMirror {
  const { storage, tenantId, userId } = opts;
  const now = opts.now ?? (() => new Date());
  const pending = new Map<string, MirrorWriteInput>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (job: () => Promise<void>): Promise<void> => {
    chain = chain.then(job).catch((err) => opts.onError?.(err));
    return chain;
  };

  const persist = (input: MirrorWriteInput): Promise<void> => {
    const hash = payloadHash(input.payload);
    const key = mirrorKey(tenantId, userId, input.localId);
    if (input.syncedHash !== null && input.syncedHash === hash) return storage.delete(key);
    const record: LocalDraftRecord = {
      localId: input.localId,
      tenantId,
      userId,
      serverDraftId: input.serverDraftId,
      serverUpdatedAt: input.serverUpdatedAt,
      syncedHash: input.syncedHash,
      customerId: input.customerId,
      customerName: input.customerName,
      payload: input.payload,
      hash,
      savedAt: now().toISOString(),
    };
    return storage.put(key, record);
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const drain = (): Promise<void> => {
    clearTimer();
    const batch = Array.from(pending.values());
    pending.clear();
    return enqueue(async () => {
      for (const input of batch) await persist(input);
    });
  };

  return {
    write(input) {
      const hash = payloadHash(input.payload);
      if (input.syncedHash !== null && input.syncedHash === hash) {
        // the server already holds exactly this: nothing local to keep, and nothing older may be written back after it
        pending.delete(input.localId);
        void enqueue(() => persist(input));
        return;
      }
      pending.set(input.localId, input);
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void drain();
      }, opts.debounceMs ?? LOCAL_MIRROR_MS);
    },
    flush: () => drain(),
    remove(localId) {
      pending.delete(localId);
      return enqueue(() => storage.delete(mirrorKey(tenantId, userId, localId)));
    },
    async list() {
      await chain; // a write queued just before must be visible to the read
      return storage.list(mirrorPrefix(tenantId, userId));
    },
    dispose() {
      clearTimer();
    },
  };
}

/**
 * Flush the mirror when the tab is hidden or the page is going away (A: "flushed on visibilitychange and pagehide").
 * Returns the detach function.
 */
export function attachMirrorFlush(
  mirror: Pick<DraftMirror, "flush">,
  doc: Document = document,
  win: Window = window,
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") void mirror.flush();
  };
  const onPageHide = () => void mirror.flush();
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("pagehide", onPageHide);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("pagehide", onPageHide);
  };
}
