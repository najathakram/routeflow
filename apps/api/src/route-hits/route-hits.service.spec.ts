import { ConfigService } from "@nestjs/config";
import { RouteHitsRedis, RouteHitsService } from "./route-hits.service";
import { routeHitsDayKey, routeHitsEnabled } from "./route-hits.constants";

function fakeRedis(opts: { failExec?: boolean } = {}) {
  const calls: unknown[][] = [];
  const pipe = {
    hincrby: (...a: unknown[]) => calls.push(["hincrby", ...a]),
    expire: (...a: unknown[]) => calls.push(["expire", ...a]),
    exec: jest.fn(async () => {
      if (opts.failExec) throw new Error("redis down");
      return [];
    }),
  };
  const redis: RouteHitsRedis = { pipeline: jest.fn(() => pipe) };
  return { redis, calls, pipe };
}
const service = (enabled = true) => {
  const s = new RouteHitsService({ get: jest.fn() } as unknown as ConfigService);
  s.enabled = enabled;
  return s;
};

describe("RouteHitsService (W3)", () => {
  it("record() is in-memory only: it calls no Redis method and returns synchronously", () => {
    const { redis } = fakeRedis();
    const s = service();
    s.attachRedis(redis);
    const out = s.record("GET /api/v1/x");
    expect(out).toBeUndefined(); // not a promise
    expect(redis.pipeline).not.toHaveBeenCalled();
  });

  it("flush writes ONE pipeline: HINCRBY per route into the UTC-day hash, then EXPIRE 45 days", async () => {
    const { redis, calls, pipe } = fakeRedis();
    const s = service();
    s.attachRedis(redis);
    s.record("GET /api/v1/x");
    s.record("GET /api/v1/x");
    s.record("POST /api/v1/y");
    const now = new Date("2026-10-02T23:59:58Z");
    await s.flush(now);
    const day = "rf:route-hits:2026-10-02";
    expect(routeHitsDayKey(now)).toBe(day);
    expect(calls).toEqual([
      ["hincrby", day, "GET /api/v1/x", 2],
      ["hincrby", day, "POST /api/v1/y", 1],
      ["expire", day, 45 * 24 * 60 * 60],
    ]);
    expect(pipe.exec).toHaveBeenCalledTimes(1);
    expect(redis.pipeline).toHaveBeenCalledTimes(1);
  });

  it("flush with nothing buffered makes no Redis call", async () => {
    const { redis } = fakeRedis();
    const s = service();
    s.attachRedis(redis);
    await s.flush();
    expect(redis.pipeline).not.toHaveBeenCalled();
  });

  it("dropped keys are written to a visible __DROPPED__ field", async () => {
    const { redis, calls } = fakeRedis();
    const s = service();
    s.attachRedis(redis);
    for (let i = 0; i < 2003; i++) s.record(`GET /k${i}`);
    await s.flush(new Date("2026-10-02T00:00:00Z"));
    expect(calls).toContainEqual(["hincrby", "rf:route-hits:2026-10-02", "__DROPPED__", 3]);
  });

  it("a Redis failure is swallowed (never thrown) and the buffer is not retried forever", async () => {
    const { redis } = fakeRedis({ failExec: true });
    const s = service();
    s.attachRedis(redis);
    s.record("GET /a");
    await expect(s.flush()).resolves.toBeUndefined();
    await s.flush(); // buffer was drained: no second attempt, no growth
    expect(redis.pipeline).toHaveBeenCalledTimes(1);
  });

  it("disabled: record is a no-op and flush writes nothing", async () => {
    const { redis } = fakeRedis();
    const s = service(false);
    s.attachRedis(redis);
    s.record("GET /a");
    await s.flush();
    expect(redis.pipeline).not.toHaveBeenCalled();
  });
});

describe("routeHitsEnabled (the kill switch)", () => {
  it("is OFF under Jest by default, ON elsewhere, and the env var wins", () => {
    expect(routeHitsEnabled({ JEST_WORKER_ID: "1" })).toBe(false);
    expect(routeHitsEnabled({})).toBe(true);
    expect(routeHitsEnabled({ ROUTE_HITS_ENABLED: "false" })).toBe(false);
    expect(routeHitsEnabled({ ROUTE_HITS_ENABLED: "true", JEST_WORKER_ID: "1" })).toBe(true);
  });
});
