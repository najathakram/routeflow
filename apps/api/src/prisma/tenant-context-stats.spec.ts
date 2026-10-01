import { Logger } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { TenantContextGuard } from "../tenant/tenant-context-guard";

/** SA-619 PR-2a: the counters are exposed by the service, and a periodic structured line is logged. */
describe("PrismaService tenant-context stats (SA-619 PR-2a)", () => {
  const make = (env: NodeJS.ProcessEnv = {}) => {
    const guard = new TenantContextGuard({ enforce: false, log: { warn: jest.fn() } });
    const prisma = new PrismaService(new TenantContextService(), guard);
    return { prisma, guard, env };
  };

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("tenantContextStats() returns the guard's stats", () => {
    const { prisma, guard } = make();
    guard.missingContext("NONE", "x.ts:1");
    expect(prisma.tenantContextStats().counts.MISSING).toBe(1);
  });

  it("startStatsLog logs one TENANT_CONTEXT_STATS line per interval (default 15 min), zeros included", () => {
    jest.useFakeTimers();
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const { prisma } = make();
    prisma.startStatsLog({});
    jest.advanceTimersByTime(15 * 60_000 - 1);
    expect(log).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(
      /^TENANT_CONTEXT_STATS \{.*"counts":\{"MISSING":0/,
    );
    jest.advanceTimersByTime(15 * 60_000);
    expect(log).toHaveBeenCalledTimes(2);
    prisma.stopStatsLog();
    jest.advanceTimersByTime(60 * 60_000);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("TENANT_CONTEXT_STATS_LOG_MS overrides the interval; 0 disables; out-of-range or junk falls back to the default (never a flood)", () => {
    jest.useFakeTimers();
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const a = make().prisma;
    a.startStatsLog({ TENANT_CONTEXT_STATS_LOG_MS: "60000" }); // the lower bound is accepted
    jest.advanceTimersByTime(3 * 60_000);
    expect(log).toHaveBeenCalledTimes(3);
    a.stopStatsLog();
    log.mockClear();
    const b = make().prisma;
    b.startStatsLog({ TENANT_CONTEXT_STATS_LOG_MS: "0" });
    jest.advanceTimersByTime(60 * 60_000);
    expect(log).not.toHaveBeenCalled();
    for (const bad of ["banana", "15", "59999", "-5", "1.5", "2147483648", "99999999999"]) {
      const c = make().prisma;
      c.startStatsLog({ TENANT_CONTEXT_STATS_LOG_MS: bad });
      jest.advanceTimersByTime(60_000); // a flood would have logged a thousand times by now
      expect(log).not.toHaveBeenCalled();
      jest.advanceTimersByTime(14 * 60_000);
      expect(log).toHaveBeenCalledTimes(1);
      c.stopStatsLog();
      log.mockClear();
    }
  });

  it("the upper bound (2^31-1 ms) is accepted as the interval", () => {
    const { prisma } = make();
    const t = jest.spyOn(global, "setInterval");
    prisma.startStatsLog({ TENANT_CONTEXT_STATS_LOG_MS: "2147483647" });
    expect(t.mock.calls[0][1]).toBe(2147483647);
    prisma.stopStatsLog();
  });

  it("the timer never keeps the process alive: unref() is actually CALLED", () => {
    const { prisma } = make();
    const unref = jest.fn();
    jest.spyOn(global, "setInterval").mockReturnValue({ unref } as any);
    jest.spyOn(global, "clearInterval").mockImplementation(() => undefined);
    prisma.startStatsLog({});
    expect(unref).toHaveBeenCalledTimes(1);
    prisma.stopStatsLog();
  });
});
