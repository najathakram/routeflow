// `@LeaderCron` wraps every cron tick in a Postgres advisory lock (common/cron-lock.ts).
// These specs invoke the tick directly and have no database, so the lock is a PASS-THROUGH here:
// it must still call the body — a mock that skipped it would make every assertion below measure
// a tick that never ran.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { RegulatedFilingCronService, previousClosedPeriod } from "./regulated-filing-cron.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("previousClosedPeriod", () => {
  it("MONTHLY → previous calendar month", () => {
    // March 2026 → February 2026
    expect(previousClosedPeriod("MONTHLY", new Date(Date.UTC(2026, 2, 15)))).toEqual({
      year: 2026,
      index: 2,
    });
  });

  it("MONTHLY → January rolls back to December of the prior year", () => {
    expect(previousClosedPeriod("MONTHLY", new Date(Date.UTC(2026, 0, 10)))).toEqual({
      year: 2025,
      index: 12,
    });
  });

  it("QUARTERLY → previous quarter", () => {
    // May 2026 (Q2) → Q1 2026
    expect(previousClosedPeriod("QUARTERLY", new Date(Date.UTC(2026, 4, 1)))).toEqual({
      year: 2026,
      index: 1,
    });
  });

  it("QUARTERLY → Q1 rolls back to Q4 of the prior year", () => {
    // January 2026 (Q1) → Q4 2025
    expect(previousClosedPeriod("QUARTERLY", new Date(Date.UTC(2026, 0, 1)))).toEqual({
      year: 2025,
      index: 4,
    });
    // March 2026 is still Q1 → also Q4 2025
    expect(previousClosedPeriod("QUARTERLY", new Date(Date.UTC(2026, 2, 31)))).toEqual({
      year: 2025,
      index: 4,
    });
  });

  it("ANNUAL → previous calendar year (index ignored)", () => {
    expect(previousClosedPeriod("ANNUAL", new Date(Date.UTC(2026, 0, 1)))).toEqual({
      year: 2025,
      index: 1,
    });
    expect(previousClosedPeriod("ANNUAL", new Date(Date.UTC(2026, 11, 31)))).toEqual({
      year: 2025,
      index: 1,
    });
  });
});

describe("RegulatedFilingCronService", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let tenantCtx: { run: jest.Mock };
  let filing: { prepareFiling: jest.Mock };
  let svc: RegulatedFilingCronService;

  beforeEach(() => {
    prisma = createMockPrisma();
    // Passthrough: run the callback synchronously inside the "context".
    tenantCtx = { run: jest.fn((_tenantId: string, fn: () => any) => fn()) };
    filing = { prepareFiling: jest.fn().mockResolvedValue({ id: "filing-1" }) };
    svc = new RegulatedFilingCronService(prisma as any, tenantCtx as any, filing as any);
  });

  it("sweeps active categories across ALL tenants (no forTenant scoping on the sweep)", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    await svc.autoPrepareClosedFilings();
    expect(prisma.trackedCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } }),
    );
    // No categories → the per-tenant forTenant() path is never entered.
    expect(prisma.forTenant).not.toHaveBeenCalled();
  });

  it("prepares the previous period for each category when no filing exists (pack tenant)", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-1", tenantId: "t1", reportCadence: "MONTHLY" },
    ]);
    prisma.tenantAddon.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    prisma.regulatedFiling.findFirst.mockResolvedValue(null);

    await svc.autoPrepareClosedFilings();

    // Runs inside the tenant's context, with userId: null (cron/system trigger).
    expect(tenantCtx.run).toHaveBeenCalledWith("t1", expect.any(Function));
    expect(filing.prepareFiling).toHaveBeenCalledWith(
      expect.objectContaining({ trackedCategoryId: "cat-1", userId: null }),
    );
  });

  it("is idempotent — skips a category whose filing already exists", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-1", tenantId: "t1", reportCadence: "MONTHLY" },
    ]);
    prisma.tenantAddon.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    prisma.regulatedFiling.findFirst.mockResolvedValue({ id: "existing" });

    await svc.autoPrepareClosedFilings();

    expect(filing.prepareFiling).not.toHaveBeenCalled();
  });

  it("continues the batch when one tenant's prepare throws", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-1", tenantId: "t1", reportCadence: "MONTHLY" },
      { id: "cat-2", tenantId: "t2", reportCadence: "QUARTERLY" },
    ]);
    prisma.tenantAddon.findMany.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }]);
    prisma.regulatedFiling.findFirst.mockResolvedValue(null);
    filing.prepareFiling
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ id: "filing-2" });

    await expect(svc.autoPrepareClosedFilings()).resolves.toBeUndefined();
    expect(filing.prepareFiling).toHaveBeenCalledTimes(2);
  });

  it("never prepares a category on a tenant without the tobacco_dealer addon", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-1", tenantId: "t1", reportCadence: "MONTHLY" },
    ]);
    prisma.tenantAddon.findMany.mockResolvedValue([]); // no active addon rows
    prisma.regulatedFiling.findFirst.mockResolvedValue(null);

    await svc.autoPrepareClosedFilings();

    expect(prisma.forTenant).not.toHaveBeenCalled();
    expect(filing.prepareFiling).not.toHaveBeenCalled();
  });

  it("prepares a category on an addon tenant while skipping one on an addon-less tenant", async () => {
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-1", tenantId: "t1", reportCadence: "MONTHLY" },
      { id: "cat-2", tenantId: "t2", reportCadence: "MONTHLY" },
    ]);
    // Only t1 has the active tobacco_dealer addon.
    prisma.tenantAddon.findMany.mockResolvedValue([{ tenantId: "t1" }]);
    prisma.regulatedFiling.findFirst.mockResolvedValue(null);

    await svc.autoPrepareClosedFilings();

    expect(tenantCtx.run).toHaveBeenCalledTimes(1);
    expect(tenantCtx.run).toHaveBeenCalledWith("t1", expect.any(Function));
    expect(filing.prepareFiling).toHaveBeenCalledTimes(1);
    expect(filing.prepareFiling).toHaveBeenCalledWith(
      expect.objectContaining({ trackedCategoryId: "cat-1" }),
    );
  });
});
