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
      unpausedAt: updatedAt, // no `at` in the value: the row's write time stands in (row 412)
    });
  });

  describe("row 412: unpausedAt is the instant of the last flip to UNPAUSED", () => {
    const updatedAt = new Date("2026-10-13T12:00:00.000Z");
    const at = "2026-10-20T08:30:00.000Z";

    it("an unpaused value carries its `at`", async () => {
      const { svc } = make([
        { value: `{"paused":false,"reason":"go live","by":"u1","at":"${at}"}`, updatedAt },
      ]);
      expect((await svc.getState()).unpausedAt).toEqual(new Date(at));
      expect(await svc.unpausedSince()).toEqual(new Date(at));
    });

    it("PAUSED (any form), a missing key and a read error expose no unpausedAt", async () => {
      for (const rows of [
        [{ value: `{"paused":true,"at":"${at}"}`, updatedAt }],
        [{ value: "true", updatedAt }],
        [],
        new Error("db down"),
      ] as const) {
        const { svc } = make(rows as any);
        expect((await svc.getState()).unpausedAt).toBeNull();
        expect(await svc.unpausedSince()).toBeNull();
      }
    });

    it.each(["false", '{"paused":false}', '{"paused":false,"at":"not a date"}'])(
      "legacy %s (no usable `at`): the row's write time is the boundary, so any final sent before it is stale",
      async (value) => {
        const { svc } = make([{ value, updatedAt }]);
        expect((await svc.getState()).unpausedAt).toEqual(updatedAt);
        expect(await svc.unpausedSince()).toEqual(updatedAt);
      },
    );

    it("setPaused(false) on an already-unpaused switch keeps the ORIGINAL `at` (it must not re-issue finals or slide locks)", async () => {
      const was = "2026-01-05T00:00:00.000Z"; // long before now
      let stored = `{"paused":false,"reason":"go live","by":"u1","at":"${was}"}`;
      const prisma = {
        $executeRaw: jest.fn(async (_s: unknown, _k: unknown, v: string) => {
          stored = v;
          return 1;
        }),
        $queryRaw: jest.fn(async () => [{ value: stored, updatedAt }]),
      } as any;
      const svc = new AutoLockSwitchService(prisma);
      const again = await svc.setPaused(false, "re-confirmed", "u2");
      expect(JSON.parse(stored)).toMatchObject({
        paused: false,
        reason: "re-confirmed",
        by: "u2",
        at: was,
      });
      expect(again.unpausedAt).toEqual(new Date(was));
      // a real pause -> unpause cycle still moves the boundary
      await svc.setPaused(true, "re-pause", "u2");
      const reopened = await svc.setPaused(false, "go live again", "u2");
      expect(reopened.unpausedAt!.getTime()).toBeGreaterThan(new Date(was).getTime());
    });

    it("unpausedSince() on an UNPAUSED value is never cached: it re-reads the store, so a re-pause is seen at once", async () => {
      const { svc, set } = makeStore(`{"paused":false,"at":"${at}"}`);
      expect(await svc.unpausedSince()).toEqual(new Date(at));
      set('{"paused":true,"reason":"re-pause","by":"u2"}');
      expect(await svc.unpausedSince()).toBeNull();
    });

    it("setPaused(false) records `at` = now, and the returned state's unpausedAt is that instant; setPaused(true) clears it", async () => {
      let stored = "";
      const prisma = {
        $executeRaw: jest.fn(async (_s: unknown, _k: unknown, v: string) => {
          stored = v;
          return 1;
        }),
        $queryRaw: jest.fn(async () => [{ value: stored, updatedAt }]),
      } as any;
      const svc = new AutoLockSwitchService(prisma);
      const before = Date.now();
      const open = await svc.setPaused(false, "go live", "u1");
      expect(JSON.parse(stored).at).toEqual(expect.any(String));
      expect(open.unpausedAt?.getTime()).toBe(new Date(JSON.parse(stored).at).getTime());
      expect(open.unpausedAt!.getTime()).toBeGreaterThanOrEqual(before);
      const shut = await svc.setPaused(true, "re-pause", "u1");
      expect(shut.unpausedAt).toBeNull();
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
