/**
 * SA-812a G-1 (MUST-2): the 06:00 standing-order cron and the units_prices_v2 fail-closed 503.
 *
 * A template whose customer has typed prices is not priced at the tier when the flag read fails: createOrderFromTemplate
 * throws the coded CUSTOMER_PRICES_UNAVAILABLE 503. The cron must not just log it (the day's standing order would be lost
 * silently): the tenant loop re-attempts each such template ONCE after a short backoff, and if it still fails it tells the
 * tenant's operators the order was held and needs "Generate now", and counts it as skipped. Any other error is unchanged:
 * logged, not retried, not announced.
 */
// @LeaderCron wraps the tick in a Postgres advisory lock (common/cron-lock.ts). There is no database here,
// so the lock is a PASS-THROUGH that still runs the body (same mock as order-templates.removed-customer.spec.ts).
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { regulatedGateOpenProvider } from "./testing/regulated-gate-open-provider";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AuditService } from "../audit/audit.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { createMockPrisma } from "../testing/prisma-mock";

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const template = (id: string, name: string, customerId: string, businessName: string) => ({
  id,
  customerId,
  name,
  isActive: true,
  daysOfWeek: EVERY_DAY,
  items: [],
  customer: { id: customerId, deletedAt: null, businessName },
});

const pricesDown = () =>
  new ServiceUnavailableException({
    statusCode: 503,
    code: API_ERROR_CODES.CUSTOMER_PRICES_UNAVAILABLE,
    message: "Customer prices are temporarily unavailable. Please try again.",
  });

describe("OrderTemplatesService.generateDailyOrders: customer prices unavailable (G-1)", () => {
  let service: OrderTemplatesService;
  let createSpy: jest.SpyInstance;
  let pauseSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const sendToUser = jest.fn();
  const sendToCustomer = jest.fn();

  async function boot(rows: any[]) {
    const prisma = createMockPrisma();
    sendToUser.mockReset().mockResolvedValue(undefined);
    sendToCustomer.mockReset().mockResolvedValue(undefined);
    const mod = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrderTemplatesService,
        regulatedGateOpenProvider,
        { provide: PrismaService, useValue: prisma },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id: string, fn: () => unknown) => fn()) },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        { provide: NotificationsService, useValue: { sendToUser, sendToCustomer } },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }] as any);
    prisma.orderTemplate.findMany.mockResolvedValue(rows as any);
    prisma.orderTemplate.count.mockResolvedValue(0);
    prisma.order.findFirst.mockResolvedValue(null); // nothing generated yet today
    prisma.user.findMany.mockResolvedValue([{ id: "op-1" }, { id: "op-2" }] as any);
    (prisma as any).getTenantId = jest.fn().mockReturnValue("tn-1");
    createSpy = jest.spyOn(service as any, "createOrderFromTemplate");
    pauseSpy = jest.spyOn(service as any, "pause").mockResolvedValue(undefined);
    logSpy = jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
  }

  const summary = () => logSpy.mock.calls.map((c) => String(c[0])).find((m) => /complete/.test(m));

  it("503 on the first attempt, success on the retry: re-attempted ONCE after a backoff, no notice", async () => {
    await boot([template("t1", "Weekly", "c1", "Acme Foods")]);
    createSpy.mockRejectedValueOnce(pricesDown()).mockResolvedValueOnce({ id: "o-1" });
    await service.generateDailyOrders();
    expect(createSpy.mock.calls.map((c) => c[0].id)).toEqual(["t1", "t1"]);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(sendToUser).not.toHaveBeenCalled();
    expect(summary()).toContain("1 created, 0 skipped");
  });

  it("503 twice: operators are told it was held and needs Generate now, and it counts as skipped", async () => {
    await boot([template("t1", "Weekly", "c1", "Acme Foods")]);
    createSpy.mockRejectedValue(pricesDown());
    await service.generateDailyOrders();
    expect(createSpy).toHaveBeenCalledTimes(2); // the attempt and exactly one retry
    expect(sendToUser).toHaveBeenCalledTimes(2); // one per operator
    const [opId, payload] = sendToUser.mock.calls[0];
    expect(opId).toBe("op-1");
    expect(payload.body).toContain("Acme Foods");
    expect(payload.body).toContain("Weekly");
    expect(payload.body).toContain("Generate now");
    expect(payload.body).toMatch(/held|not placed/i);
    expect(sendToCustomer).not.toHaveBeenCalled(); // the buyer is not told about our outage
    expect(summary()).toContain("0 created, 1 skipped");
  });

  it("the retry waits until every other template of the tenant has run", async () => {
    await boot([
      template("t1", "Weekly", "c1", "Acme Foods"),
      template("t2", "Daily", "c2", "Beta Mart"),
    ]);
    createSpy.mockImplementation(async (t: { id: string }) => {
      if (t.id === "t1" && createSpy.mock.calls.filter((c) => c[0].id === "t1").length === 1)
        throw pricesDown();
      return { id: `o-${t.id}` };
    });
    await service.generateDailyOrders();
    expect(createSpy.mock.calls.map((c) => c[0].id)).toEqual(["t1", "t2", "t1"]);
    expect(summary()).toContain("2 created, 0 skipped");
  });

  it("one backoff for the WHOLE run: two tenants both held wait once, then each retries in its own scope", async () => {
    await boot([]);
    const prisma = (service as any).prisma;
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }, { id: "tn-2" }]);
    prisma.orderTemplate.findMany
      .mockResolvedValueOnce([template("t1", "Weekly", "c1", "Acme Foods")])
      .mockResolvedValueOnce([template("t2", "Daily", "c2", "Beta Mart")]);
    const tenantRun = (service as any).tenantCtx.run as jest.Mock;
    createSpy.mockImplementation(async (t: { id: string }) => {
      if (createSpy.mock.calls.filter((c) => c[0].id === t.id).length === 1) throw pricesDown();
      return { id: `o-${t.id}` };
    });
    await service.generateDailyOrders();
    // both first attempts, THEN both retries, with exactly one pause between the two phases
    expect(createSpy.mock.calls.map((c) => c[0].id)).toEqual(["t1", "t2", "t1", "t2"]);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(tenantRun.mock.calls.map((c) => c[0])).toEqual(["tn-1", "tn-2", "tn-1", "tn-2"]);
    expect(summary()).toContain("2 created, 0 skipped");
  });

  it("two tenants held twice: each tenant's operators are told, and the pause is still one", async () => {
    await boot([]);
    const prisma = (service as any).prisma;
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }, { id: "tn-2" }]);
    prisma.orderTemplate.findMany
      .mockResolvedValueOnce([template("t1", "Weekly", "c1", "Acme Foods")])
      .mockResolvedValueOnce([template("t2", "Daily", "c2", "Beta Mart")]);
    createSpy.mockRejectedValue(pricesDown());
    await service.generateDailyOrders();
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(sendToUser.mock.calls.filter((c) => /Acme Foods/.test(c[1].body))).toHaveLength(2);
    expect(sendToUser.mock.calls.filter((c) => /Beta Mart/.test(c[1].body))).toHaveLength(2);
    expect(summary()).toContain("0 created, 2 skipped");
  });

  it("any other error is logged only: not retried, not announced", async () => {
    await boot([template("t1", "Weekly", "c1", "Acme Foods")]);
    createSpy.mockRejectedValue(new Error("boom"));
    await service.generateDailyOrders();
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it("a different 503 (not the customer-prices code) is not retried either", async () => {
    await boot([template("t1", "Weekly", "c1", "Acme Foods")]);
    createSpy.mockRejectedValue(new ServiceUnavailableException("busy"));
    await service.generateDailyOrders();
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(sendToUser).not.toHaveBeenCalled();
  });
});
