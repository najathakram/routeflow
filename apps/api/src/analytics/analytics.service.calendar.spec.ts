import { Test, TestingModule } from "@nestjs/testing";
import { AnalyticsService } from "./analytics.service";
import { PrismaService } from "../prisma/prisma.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * B118 — On-Time % must judge a completed stop against the END of its run's
 * scheduledDate calendar day AS OBSERVED IN THE TENANT'S CONFIGURED TIMEZONE,
 * not a fixed UTC day-end. The pre-fix `accumulateRunMetrics` hardcoded
 * `dayEnd.setUTCHours(23, 59, 59, 999)`, so a tenant WEST of UTC (e.g.
 * America/New_York, UTC−4/−5) has its real local day-end land HOURS AFTER the
 * UTC one — 2026-06-11T03:59:59.999Z versus 2026-06-10T23:59:59.999Z — so the
 * fixed UTC cutoff fired early and a genuinely on-time evening delivery read
 * as late.
 *
 * The change moves the boundary in BOTH directions and both are pinned here.
 * For a tenant EAST of UTC the new day-end is EARLIER than the old one
 * (Pacific/Auckland's is 2026-06-10T11:59:59.999Z), so stops that the fixed
 * UTC cutoff counted on-time now correctly count as late — a customer-visible
 * metric moving down, which is why it gets its own case rather than being left
 * to the west-of-UTC ones.
 *
 * See bug-test-plan.md T7-T9. This file was red at the red gate:
 * `resolveCurrentTenantTimezone` and the tenant-aware day-end did not exist,
 * so `prisma.tenantConfig.findUnique` was never consulted by the service.
 */
describe("AnalyticsService — B118 tenant-timezone on-time cutoff", () => {
  let service: AnalyticsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let addonService: { hasAddon: jest.Mock };
  let systemConfig: { get: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    addonService = { hasAddon: jest.fn().mockResolvedValue(false) };
    systemConfig = { get: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AddonService, useValue: addonService },
        { provide: SystemConfigService, useValue: systemConfig },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  const run = (over: Record<string, unknown> = {}) => ({
    routeId: "r1",
    status: "COMPLETED",
    scheduledDate: new Date("2026-06-10T00:00:00.000Z"),
    startedAt: new Date("2026-06-10T08:00:00.000Z"),
    completedAt: new Date("2026-06-10T10:00:00.000Z"),
    route: { id: "r1", name: "North Loop" },
    orders: [],
    stops: [],
    ...over,
  });
  const stopAt = (iso: string) => ({ completedAt: new Date(iso) });

  it("REG-B118 counts an 8:15pm-local delivery on-time for an America/New_York tenant", async () => {
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/New_York" });
    prisma.routeRun.findMany.mockResolvedValue([
      // 2026-06-11T00:15:00.000Z is 8:15pm EDT on 2026-06-10 — still the
      // scheduled tenant-local calendar day. Today's fixed UTC cutoff of
      // 2026-06-10T23:59:59.999Z is 7:59:59pm EDT, so this stop reads as late.
      run({ stops: [stopAt("2026-06-11T00:15:00.000Z")] }),
    ]);

    const [row] = await service.getRoutePerformance();

    expect(row.onTimeRate).toBe(100);
  });

  // GUARD (not REG): passes today AND after the fix — it holds the opposite direction so
  // the fix cannot simply score everything on-time. Deliberately NOT tagged REG-B, so the
  // `-t "REG-B"` red gate does not select a test that is expected to pass.
  it("GUARD-B118 still counts a genuinely-next-day (local) completion as late", async () => {
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/New_York" });
    prisma.routeRun.findMany.mockResolvedValue([
      // 2026-06-11T06:00:00.000Z is 2:00am EDT on 2026-06-11 — genuinely the
      // following tenant-local calendar day, regardless of which day-end rule applies.
      run({ stops: [stopAt("2026-06-11T06:00:00.000Z")] }),
    ]);

    const [row] = await service.getRoutePerformance();

    expect(row.onTimeRate).toBe(0);
  });

  // The opposite direction: east of UTC the tenant-local day-end lands BEFORE
  // the old fixed UTC cutoff, so the fix makes a previously "on-time" stop late.
  // Deliberately NOT tagged REG-B: it is red on the pre-fix code too (which
  // scored it on-time), but it is a direction the fix must own, not a bug pin.
  it("GUARD-B118 counts a post-local-midnight stop as LATE for an east-of-UTC (Pacific/Auckland) tenant", async () => {
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "Pacific/Auckland" });
    prisma.routeRun.findMany.mockResolvedValue([
      // Auckland is UTC+12 (NZST) in June, so the tenant-local end of
      // 2026-06-10 is 2026-06-10T11:59:59.999Z. A stop at 20:00Z is 8am on
      // 2026-06-11 locally — genuinely the next tenant day — yet it sits
      // comfortably inside the old fixed UTC cutoff of 23:59:59.999Z, which
      // would have scored it on-time.
      run({ stops: [stopAt("2026-06-10T20:00:00.000Z")] }),
    ]);

    const [row] = await service.getRoutePerformance();

    expect(row.onTimeRate).toBe(0);
  });

  it("REG-B118 DST edge — 2026-03-08 (America/New_York spring-forward day) resolves the correct UTC day-end", async () => {
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/New_York" });
    prisma.routeRun.findMany.mockResolvedValue([
      run({
        scheduledDate: new Date("2026-03-08T00:00:00.000Z"),
        startedAt: new Date("2026-03-08T12:00:00.000Z"),
        completedAt: new Date("2026-03-08T20:00:00.000Z"),
        // 2026-03-09T03:45:00.000Z is 11:45pm EDT on 2026-03-08 (spring-forward
        // already happened at 2am local that day, so the zone is EDT/UTC-4 by
        // evening). Today's fixed UTC cutoff of 2026-03-08T23:59:59.999Z is
        // 6:59:59pm EDT, so this stop reads as late.
        stops: [stopAt("2026-03-09T03:45:00.000Z")],
      }),
    ]);

    const [row] = await service.getRoutePerformance();

    expect(row.onTimeRate).toBe(100);
  });
});

/**
 * Siblings of B118 found by the review sweep — both in `analytics.service.ts`,
 * both the same defect class: a CALENDAR-date field (`Invoice.issueDate`, stored
 * at UTC midnight — see `common/calendar-date.ts`) read through HOST-LOCAL
 * calendar components.
 *
 *   • `getRevenueTrend`'s month branch keyed off `issueDate.getFullYear()` /
 *     `.getMonth()` while its own day branch used `toISOString()`, so on a
 *     negative-offset host a 2026-01-01 invoice landed in the "2025-12" bucket.
 *   • `dateRange`'s default `fromDate` was `new Date(year, 0, 1)` — the
 *     two-argument constructor also reads host-local components — so the
 *     parameterless window opened AFTER UTC midnight of January 1 and the `gte`
 *     filter dropped every invoice dated January 1.
 *
 * WHY THE FIRST CASE USES A DATE STUB. On a UTC host the local calendar
 * components ARE the UTC ones, so the pre-fix and post-fix bodies behave
 * identically and NO real-Date fixture can separate them. The API image sets no
 * TZ and GitHub runners are UTC, so a real-Date-only test is green against the
 * buggy code in exactly the environment the gate runs in. Pinning
 * `process.env.TZ` does not help either — jest hands the sandbox a COPY of
 * `process.env`, so the assignment never reaches Node's timezone cache and the
 * pin is inert (measured here; same trap `apps/mobile/__tests__/run-lateness.test.ts`
 * documents). Passing the zone as DATA is the remedy that works: a Date whose
 * LOCAL getters report December while its ISO/UTC view reports January is what a
 * real Date looks like on any host west of UTC, and it discriminates on every
 * host including a UTC one.
 */
describe("AnalyticsService — invoice date windows/buckets read UTC, not host-local", () => {
  let service: AnalyticsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  it("keys the month from the UTC components even when the LOCAL ones say December", async () => {
    // The zone as data: ISO/UTC view = 2026-01-01, local view = 2025-12-31.
    // The pre-fix `${getFullYear()}-${getMonth()+1}` body reads "2025-12" from
    // this object on EVERY host; the shipped `toISOString().slice(0, 7)` reads
    // "2026-01" on every host.
    const seenLocallyAsDecember = Object.assign(new Date("2026-01-01T00:00:00.000Z"), {
      getFullYear: () => 2025,
      getMonth: () => 11,
    });
    prisma.invoice.findMany.mockResolvedValue([{ issueDate: seenLocallyAsDecember, total: 100 }]);

    const rows = await service.getRevenueTrend("2025-12-01", "2026-01-31", "month");

    expect(rows.map((r) => r.period)).toEqual(["2026-01"]);
    expect(rows.map((r) => r.period)).not.toContain("2025-12");
  });

  it("buckets real New Year invoices under the UTC month, never the previous local one", async () => {
    prisma.invoice.findMany.mockResolvedValue([
      // The storage convention: a calendar date written at UTC midnight.
      { issueDate: new Date("2026-01-01T00:00:00.000Z"), total: 100 },
      // A legacy row carrying a real time-of-day. It straddles a month boundary
      // in a west-of-UTC zone but NOT in UTC: 2026-01-01T03:00Z is 2025-12-31
      // 22:00 in America/New_York, so the old local key was "2025-12" there
      // while the correct UTC key is "2026-01". (On a UTC runner both keys are
      // "2026-01" — which is why the stub case above exists.)
      { issueDate: new Date("2026-01-01T03:00:00.000Z"), total: 200 },
    ]);

    const rows = await service.getRevenueTrend("2025-12-01", "2026-01-31", "month");

    expect(rows.map((r) => r.period)).toEqual(["2026-01"]);
    expect(rows[0].revenue).toBe(300);
  });

  it("opens the default window at UTC midnight of January 1, not the host-local one", async () => {
    await service.getRevenueTrend();

    const where = prisma.invoice.findMany.mock.calls[0][0].where as {
      issueDate: { gte: Date; lte: Date };
    };
    const year = new Date().getUTCFullYear();
    // A pin, not a red-gate proof: `new Date(year, 0, 1)` yields this same
    // instant on a UTC runner. On any host west of UTC it yields
    // `${year}-01-01T05:00:00.000Z`-ish instead, which excludes every invoice
    // stored at `${year}-01-01T00:00:00.000Z` — the January-1 drop.
    expect(where.issueDate.gte.toISOString()).toBe(`${year}-01-01T00:00:00.000Z`);
  });
});
