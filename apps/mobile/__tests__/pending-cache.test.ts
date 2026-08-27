import { createPendingCache } from "../lib/pending-cache";

/**
 * Pins the cache contract behind the share paths' "tap again to share"
 * recovery (share-pdf.ts, PDF and CSV alike): the retap must find the FIRST
 * tap's download — still pending or already resolved — under the same key,
 * a failed download must not poison the cache, and the LRU cap must only
 * ever drop the oldest entry.
 */
describe("createPendingCache", () => {
  it("returns the SAME promise for the same key while still pending (the retap fast path)", async () => {
    let resolveFirst!: (v: string) => void;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const cache = createPendingCache<string>(3);

    const got1 = cache.get("url", () => first);
    const got2 = cache.get("url", () => Promise.resolve("re-fetched"));
    expect(got2).toBe(got1);

    resolveFirst("csv-bytes");
    await expect(got2).resolves.toBe("csv-bytes");
  });

  it("release frees the entry so the next get re-makes it", () => {
    const cache = createPendingCache<string>(3);
    cache.get("url", () => Promise.resolve("a"));
    cache.release("url");

    const remade = Promise.resolve("b");
    expect(cache.get("url", () => remade)).toBe(remade);
  });

  it("evicts a rejected entry so the next tap retries instead of re-failing", async () => {
    const cache = createPendingCache<string>(3);
    const failing = cache.get("url", () => Promise.reject(new Error("offline")));
    await failing.catch(() => {});

    const retry = Promise.resolve("ok");
    expect(cache.get("url", () => retry)).toBe(retry);
  });

  it("a LATE rejection can't evict the newer entry that replaced it", async () => {
    let rejectFirst!: (e: Error) => void;
    const first = new Promise<string>((_, reject) => {
      rejectFirst = reject;
    });
    const cache = createPendingCache<string>(3);

    cache.get("url", () => first);
    cache.release("url");
    const replacement = Promise.resolve("fresh");
    const got = cache.get("url", () => replacement);

    rejectFirst(new Error("late failure"));
    await first.catch(() => {});
    await Promise.resolve(); // let the eviction microtask run

    expect(cache.get("url", () => Promise.resolve("would-be-refetch"))).toBe(got);
  });

  it("caps entries LRU-style — a re-get bumps recency, the oldest is dropped", () => {
    const cache = createPendingCache<number>(2);
    const a = Promise.resolve(1);
    const b = Promise.resolve(2);
    cache.get("a", () => a);
    cache.get("b", () => b);

    // Bump "a" to most-recently-used, then overflow: "b" is now the oldest.
    expect(cache.get("a", () => Promise.resolve(9))).toBe(a);
    cache.get("c", () => Promise.resolve(3));

    expect(cache.get("a", () => Promise.resolve(9))).toBe(a);
    const bRemade = Promise.resolve(20);
    expect(cache.get("b", () => bRemade)).toBe(bRemade);
  });

  describe("peek", () => {
    it("returns undefined while pending, the value once resolved, undefined after release", async () => {
      const cache = createPendingCache<string>(3);
      let resolve!: (v: string) => void;
      const p = new Promise<string>((r) => (resolve = r));
      cache.get("url", () => p);

      expect(cache.peek("url")).toBeUndefined();
      resolve("file-bytes");
      await p;
      await Promise.resolve();
      expect(cache.peek("url")).toBe("file-bytes");

      cache.release("url");
      expect(cache.peek("url")).toBeUndefined();
    });

    it("a late resolve cannot resurrect a value for a replaced entry", async () => {
      const cache = createPendingCache<string>(3);
      let resolveFirst!: (v: string) => void;
      const first = new Promise<string>((r) => (resolveFirst = r));
      cache.get("url", () => first);
      cache.release("url");
      cache.get("url", () => new Promise<string>(() => {}));

      resolveFirst("stale");
      await first;
      await Promise.resolve();
      expect(cache.peek("url")).toBeUndefined();
    });

    it("LRU eviction clears the resolved value too", async () => {
      const cache = createPendingCache<number>(1);
      const a = Promise.resolve(1);
      cache.get("a", () => a);
      await a;
      await Promise.resolve();
      expect(cache.peek("a")).toBe(1);

      cache.get("b", () => Promise.resolve(2));
      expect(cache.peek("a")).toBeUndefined();
    });
  });
});
