/**
 * Keyed LRU cache of in-flight promises — extracted from share-pdf.ts's
 * per-url PDF file cache so the CSV share path can reuse it and so the
 * eviction contract is unit-testable (this module must stay free of
 * react-native and DOM imports; the mobile Jest env is node-only).
 *
 * The contract, pinned by __tests__/pending-cache.test.ts:
 *
 *  - `get(key, make)` returns the cached promise for `key` when one exists —
 *    even while still pending — re-inserting it as most-recently-used. This
 *    is what lets a "second tap" (see share-pdf.ts's retap recovery) hand
 *    `navigator.share()` an already-downloaded File synchronously instead of
 *    burning the fresh activation on a re-fetch.
 *  - A rejected promise evicts itself so the next `get` retries — identity-
 *    checked, so a LATE rejection can't evict a newer entry that a retry has
 *    since put in its place.
 *  - Past `max` entries the oldest is dropped (Map iterates in insertion
 *    order). Entries pin whole files' bytes in memory on a long-lived Expo
 *    Web session, and some attempts never reach a terminal outcome (the
 *    operator dismisses the retap dialog, or navigates away mid-fetch) — the
 *    cap keeps only the most recent handful alive.
 *  - `release(key)` frees an entry once its attempt reaches a terminal
 *    outcome.
 */
export interface PendingCache<T> {
  get(key: string, make: () => Promise<T>): Promise<T>;
  release(key: string): void;
}

export function createPendingCache<T>(max: number): PendingCache<T> {
  const entries = new Map<string, Promise<T>>();
  return {
    get(key, make) {
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key);
        entries.set(key, cached);
        return cached;
      }
      const pending = make();
      entries.set(key, pending);
      pending.catch(() => {
        if (entries.get(key) === pending) entries.delete(key);
      });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return pending;
    },
    release(key) {
      entries.delete(key);
    },
  };
}
