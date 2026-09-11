// @LeaderCron wraps the tick in a Postgres advisory lock (common/cron-lock.ts). There is no database here,
// so the lock is a PASS-THROUGH that still runs the body (same mock as recurring-invoices.service.spec.ts).
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { Test } from "@nestjs/testing";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";

// Honest stand-in for Postgres: applies the `where` the service actually sends, so a where-only fix is
// observable (L-081: a mock that injects a fixed result cannot see one). Strict: an unmodelled filter
// shape throws instead of silently matching.
function matchesWhere(row: any, where: any = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "customer") {
      const rel = (cond as any)?.is ?? cond;
      if (
        !rel ||
        !Object.prototype.hasOwnProperty.call(rel, "deletedAt") ||
        rel.deletedAt !== null
      ) {
        throw new Error(`matchesWhere: unsupported customer filter ${JSON.stringify(cond)}`);
      }
      if (row.customer.deletedAt !== null) return false;
      continue;
    }
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as any;
      if ("has" in c) {
        if (!row[key].includes(c.has)) return false;
      } else if ("in" in c) {
        if (!c.in.includes(row[key])) return false;
      } else if ("lte" in c) {
        if (!(row[key] <= c.lte)) return false;
      } else {
        throw new Error(`matchesWhere: unsupported filter on ${key}: ${JSON.stringify(cond)}`);
      }
      continue;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

const REMOVED_AT = new Date("2026-09-01T00:00:00.000Z");

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const templates = (removedAt: Date | null) => [
  {
    id: "t-live",
    customerId: "c-live",
    name: "Live",
    isActive: true,
    daysOfWeek: EVERY_DAY,
    items: [],
    customer: { id: "c-live", deletedAt: null },
  },
  {
    id: "t-removed",
    customerId: "c-removed",
    name: "Removed",
    isActive: true,
    daysOfWeek: EVERY_DAY,
    items: [],
    customer: { id: "c-removed", deletedAt: removedAt },
  },
];

describe("OrderTemplatesService.generateDailyOrders — removed customer (B131)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let createSpy: jest.SpyInstance;

  async function boot(rows: any[]) {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id: string, fn: () => unknown) => fn()) },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }] as any);
    prisma.orderTemplate.findMany.mockImplementation((async (args: any) =>
      rows.filter((r) => matchesWhere(r, args?.where))) as any);
    prisma.order.findFirst.mockResolvedValue(null); // nothing generated yet today
    createSpy = jest
      .spyOn(service as any, "createOrderFromTemplate")
      .mockResolvedValue({ id: "o-1" });
  }

  it("REG-B131 T1: generateDailyOrders skips an active template whose customer was removed", async () => {
    await boot(templates(REMOVED_AT));
    await service.generateDailyOrders();
    expect(createSpy.mock.calls.map((c) => c[0].id)).toEqual(["t-live"]);
  });

  it("B131 P1: a restored customer's template fires again", async () => {
    await boot(templates(null));
    await service.generateDailyOrders();
    expect(createSpy.mock.calls.map((c) => c[0].id)).toEqual(["t-live", "t-removed"]);
  });

  // Observability of the suppression itself: a suppressed template enters neither counter, so without
  // these lines a tenant whose only due template belongs to a removed customer is indistinguishable
  // from a tenant with no templates. createMockPrisma() defaults every count() to 0, which is why the
  // tests above (and every other spec on this service) stay green with no extra mock.
  it("REG-B131 T9: generateDailyOrders warns per tenant and totals the suppressed templates", async () => {
    await boot(templates(REMOVED_AT));
    prisma.orderTemplate.count.mockResolvedValue(2 as any);
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => {});
    const log = jest.spyOn((service as any).logger, "log").mockImplementation(() => {});

    await service.generateDailyOrders();

    // The warned number must come from the suppressed set, not from any set: a count whose where is
    // flipped (or loses the relation filter) would log a confident wrong number, so pin the filter.
    expect(prisma.orderTemplate.count).toHaveBeenCalledTimes(1);
    expect(prisma.orderTemplate.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customer: { deletedAt: { not: null } } }),
      }),
    );

    const suppressionWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("REG-B131"));
    expect(suppressionWarnings).toHaveLength(1);
    expect(suppressionWarnings[0]).toContain("tn-1");
    expect(suppressionWarnings[0]).toContain("2");
    expect(log.mock.calls.map((c) => String(c[0])).some((m) => m.includes("2 suppressed"))).toBe(
      true,
    );
  });

  it("B131 P10: generateDailyOrders does not warn when nothing is suppressed", async () => {
    await boot(templates(null));
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => {});

    await service.generateDailyOrders();

    expect(warn.mock.calls.filter((c) => String(c[0]).includes("REG-B131"))).toHaveLength(0);
  });
});
