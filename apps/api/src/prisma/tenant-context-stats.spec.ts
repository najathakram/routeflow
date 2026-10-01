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

  it("TENANT_CONTEXT_STATS_LOG_MS overrides the interval; 0 disables; junk falls back to the default", () => {
    jest.useFakeTimers();
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const a = make().prisma;
    a.startStatsLog({ TENANT_CONTEXT_STATS_LOG_MS: "1000" });
    jest.advanceTimersByTime(3_000);
    expect(log).toHaveBeenCalledTimes(3);
    a.stopStatsLog();
    log.mockClear();
    const b = make().prisma;
    b.startStatsLog({ TENANT_CONTEXT_STATS_LOG_MS: "0" });
    jest.advanceTimersByTime(60 * 60_000);
    expect(log).not.toHaveBeenCalled();
    const c = make().prisma;
    c.startStatsLog({ TENANT_CONTEXT_STATS_LOG_MS: "banana" });
    jest.advanceTimersByTime(15 * 60_000);
    expect(log).toHaveBeenCalledTimes(1);
    c.stopStatsLog();
  });

  it("the timer never keeps the process alive (unref'd)", () => {
    const { prisma } = make();
    const t = jest.spyOn(global, "setInterval");
    prisma.startStatsLog({});
    const handle: any = t.mock.results[0].value;
    expect(typeof handle.unref).toBe("function");
    prisma.stopStatsLog();
  });
});
