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

  it("caches the read (one query inside the TTL) and re-reads after invalidate()", async () => {
    const { svc, queryRaw } = make([{ value: "false", updatedAt: new Date() }]);
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
      const { svc, queryRaw } = make([{ value: "false", updatedAt: new Date() }]);
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
