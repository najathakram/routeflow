import { QuickKeysRankCache } from "./quick-keys-rank.cache";

const HOUR = 60 * 60 * 1000;

describe("QuickKeysRankCache", () => {
  let now = 1_000_000;
  let cache: QuickKeysRankCache;
  beforeEach(() => {
    now = 1_000_000;
    cache = new QuickKeysRankCache();
    cache.clock = () => now;
  });

  it("misses when empty, hits within the TTL", () => {
    expect(cache.get("t1", "main", 30)).toBeUndefined();
    cache.set("t1", "main", 30, ["p1", "p2"]);
    now += HOUR - 1;
    expect(cache.get("t1", "main", 30)).toEqual(["p1", "p2"]);
  });

  it("expires after one hour", () => {
    cache.set("t1", "main", 30, ["p1"]);
    now += HOUR;
    expect(cache.get("t1", "main", 30)).toBeUndefined();
  });

  it("is keyed by tenant and register", () => {
    cache.set("t1", "main", 30, ["a"]);
    cache.set("t2", "main", 30, ["b"]);
    cache.set("t1", "front", 30, ["c"]);
    expect(cache.get("t1", "main", 30)).toEqual(["a"]);
    expect(cache.get("t2", "main", 30)).toEqual(["b"]);
    expect(cache.get("t1", "front", 30)).toEqual(["c"]);
  });

  it("misses when the look-back window changed", () => {
    cache.set("t1", "main", 30, ["a"]);
    expect(cache.get("t1", "main", 7)).toBeUndefined();
  });

  it("invalidateTenant drops every register of that tenant only", () => {
    cache.set("t1", "main", 30, ["a"]);
    cache.set("t1", "front", 30, ["c"]);
    cache.set("t2", "main", 30, ["b"]);
    cache.invalidateTenant("t1");
    expect(cache.get("t1", "main", 30)).toBeUndefined();
    expect(cache.get("t1", "front", 30)).toBeUndefined();
    expect(cache.get("t2", "main", 30)).toEqual(["b"]);
  });

  it("a tenant id that is a prefix of another is not dropped by mistake", () => {
    cache.set("t1", "main", 30, ["a"]);
    cache.set("t10", "main", 30, ["b"]);
    cache.invalidateTenant("t1");
    expect(cache.get("t10", "main", 30)).toEqual(["b"]);
  });

  it("returns a copy, so a caller cannot edit the cached ranking", () => {
    cache.set("t1", "main", 30, ["a"]);
    cache.get("t1", "main", 30)!.push("zzz");
    expect(cache.get("t1", "main", 30)).toEqual(["a"]);
  });

  it("is bounded: the oldest entries go when it is full", () => {
    for (let i = 0; i < 1100; i += 1) cache.set(`t${i}`, "main", 30, ["a"]);
    expect(cache.size()).toBeLessThanOrEqual(1000);
    expect(cache.get("t1099", "main", 30)).toEqual(["a"]);
    expect(cache.get("t0", "main", 30)).toBeUndefined();
  });
});
