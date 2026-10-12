import { AutoLockSwitchService, parseAutoLockStored } from "./auto-lock-switch.service";

function make(rows: Array<{ value: string; updatedAt: Date }> | Error) {
  const queryRaw = jest.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const executeRaw = jest.fn().mockResolvedValue(1);
  const prisma = { $queryRaw: queryRaw, $executeRaw: executeRaw } as any;
  return { svc: new AutoLockSwitchService(prisma), queryRaw, executeRaw };
}

/** A store whose row can be flipped between calls, like another replica writing the switch. */
function makeStore(initial: string | Error) {
  let current: string | Error = initial;
  const queryRaw = jest.fn(async () => {
    if (current instanceof Error) throw current;
    return [{ value: current, updatedAt: new Date("2026-10-13T12:00:00.000Z") }];
  });
  const prisma = { $queryRaw: queryRaw, $executeRaw: jest.fn() } as any;
  return {
    svc: new AutoLockSwitchService(prisma),
    queryRaw,
    set: (v: string | Error) => {
      current = v;
    },
  };
}

describe("parseAutoLockStored: paused unless the value explicitly says not", () => {
  it.each([
    [null, true],
    [undefined, true],
    ["", true],
    ["true", true],
    ["paused", true],
    ["0", true],
    ["not json {", true],
    ['{"paused":"false"}', true],
    ['{"reason":"x"}', true],
    ["null", true],
    ['{"paused":true,"reason":"rollout","by":"u1"}', true],
    ["false", false],
    ["FALSE", false],
    ["  false  ", false],
    ['{"paused":false,"reason":"go live","by":"u1"}', false],
  ])("%j -> paused=%s", (raw, paused) => {
    expect(parseAutoLockStored(raw as string | null).paused).toBe(paused);
  });

  it("carries the reason and the actor of a JSON value", () => {
    expect(parseAutoLockStored('{"paused":false,"reason":"go live","by":"u1"}')).toEqual({
      paused: false,
      reason: "go live",
      by: "u1",
    });
  });
});

describe("AutoLockSwitchService", () => {
  it("a MISSING key is PAUSED (the rollout starts paused with no seed step)", async () => {
    const { svc } = make([]);
    expect(await svc.isPaused()).toBe(true);
    expect((await svc.getState()).since).toBeNull();
  });

  it("an explicit false is UNPAUSED, and exposes since/reason/by", async () => {
    const updatedAt = new Date("2026-10-13T12:00:00.000Z");
    const { svc } = make([{ value: '{"paused":false,"reason":"go live","by":"u1"}', updatedAt }]);
    expect(await svc.isPaused()).toBe(false);
    expect(await svc.getState()).toEqual({
      paused: false,
      since: updatedAt,
      reason: "go live",
      by: "u1",
    });
  });

  it("caches a PAUSED read (one query inside the TTL) and re-reads after invalidate()", async () => {
    const { svc, queryRaw } = make([{ value: '{"paused":true}', updatedAt: new Date() }]);
    await svc.isPaused();
    await svc.isPaused();
    await svc.isPaused();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    svc.invalidate();
    await svc.isPaused();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("re-reads once the cache TTL has passed (<= 60 s by spec)", async () => {
    expect(AutoLockSwitchService.CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
    const spy = jest.spyOn(Date, "now");
    try {
      spy.mockReturnValue(1_000_000);
      const { svc, queryRaw } = make([{ value: '{"paused":true}', updatedAt: new Date() }]);
      await svc.isPaused();
      spy.mockReturnValue(1_000_000 + AutoLockSwitchService.CACHE_TTL_MS + 1);
      await svc.isPaused();
      expect(queryRaw).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("a read error fails CLOSED (paused) and is not cached", async () => {
    const { svc, queryRaw } = make(new Error("db down"));
    expect(await svc.isPaused()).toBe(true);
    expect(await svc.isPaused()).toBe(true);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  describe("a re-pause takes effect on every replica at once (only PAUSED is cached)", () => {
    let spy: jest.SpyInstance;
    beforeEach(() => {
      spy = jest.spyOn(Date, "now").mockReturnValue(2_000_000);
    });
    afterEach(() => spy.mockRestore());

    it("an UNPAUSED value is never served from cache: every call re-reads the store", async () => {
      const { svc, queryRaw } = makeStore("false");
      expect(await svc.isPaused()).toBe(false);
      expect(await svc.isPaused()).toBe(false);
      expect(await svc.isPaused()).toBe(false);
      expect(queryRaw).toHaveBeenCalledTimes(3);
    });

    it("a flip to PAUSED in the store is seen on the NEXT call, with no TTL wait", async () => {
      const { svc, set } = makeStore("false");
      expect(await svc.isPaused()).toBe(false); // the cache now holds (or skips) unpaused
      set('{"paused":true,"reason":"re-pause","by":"u2"}');
      expect(await svc.isPaused()).toBe(true); // same instant: Date.now() has not moved
    });

    it("a PAUSED value is cached within the TTL (one store read) and re-read after it", async () => {
      const { svc, queryRaw, set } = makeStore('{"paused":true}');
      expect(await svc.isPaused()).toBe(true);
      set("false"); // converges only after the TTL (the safe direction)
      spy.mockReturnValue(2_000_000 + AutoLockSwitchService.CACHE_TTL_MS - 1);
      expect(await svc.isPaused()).toBe(true);
      expect(queryRaw).toHaveBeenCalledTimes(1);
      spy.mockReturnValue(2_000_000 + AutoLockSwitchService.CACHE_TTL_MS + 1);
      expect(await svc.isPaused()).toBe(false);
      expect(queryRaw).toHaveBeenCalledTimes(2);
    });

    it("a read error is PAUSED and not cached: the next call reads again and sees the real value", async () => {
      const { svc, queryRaw, set } = makeStore(new Error("db down"));
      expect(await svc.isPaused()).toBe(true);
      set("false");
      expect(await svc.isPaused()).toBe(false);
      expect(queryRaw).toHaveBeenCalledTimes(2);
    });
  });

  it("setPaused upserts the JSON value, refreshes the cache at once, and returns the new state", async () => {
    const { svc, queryRaw, executeRaw } = make([
      { value: '{"paused":false,"reason":"r","by":"u1"}', updatedAt: new Date() },
    ]);
    await svc.isPaused(); // prime the cache
    const state = await svc.setPaused(false, "r", "u1");
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const written = JSON.parse(String((executeRaw.mock.calls as any[][])[0][2]));
    expect(written).toMatchObject({ paused: false, reason: "r", by: "u1" });
    expect(queryRaw).toHaveBeenCalledTimes(2); // primed + the post-write refresh
    expect(state.paused).toBe(false);
  });
});
