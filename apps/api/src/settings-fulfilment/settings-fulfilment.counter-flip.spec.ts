/**
 * The point of the counter switch: after a tenant admin flips it in Settings, the counter-sale gate
 * (the REAL DefaultFulfilmentCapabilityReader over the real FeatureConfigService) follows at once.
 * Off: POST /orders/counter-sale is 403 COUNTER_SALES_DISABLED. On: it rings. The read-only
 * GET .../counter-sale/by-key/:key never carried the gate and still does not (404 for an unknown
 * key, never 403).
 */
// OrdersService / InvoicesService pull ESM-only modules Jest cannot load; they are boundary mocks.
jest.mock("../orders/orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.requireActual("./testing/lock-mock").fakeWithAdvisoryLock,
}));

import "reflect-metadata";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { DefaultFulfilmentCapabilityReader } from "../orders/counter-sale/fulfilment-capability-reader";
import { CounterSaleService } from "../orders/counter-sale/counter-sale.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SettingsFulfilmentService } from "./settings-fulfilment.service";
import { createWorld, TENANT_ID } from "./testing/fulfilment-world";
import { resetLockState } from "./testing/lock-mock";

const admin = {
  sub: "u-ada",
  username: "ada",
  role: "TENANT_ADMIN",
  tenantId: TENANT_ID,
  tenantSlug: "qa-acme",
} as JwtPayload;
const sale = {
  customerId: "cust-1",
  items: [{ productId: "p1", qty: 1, unitPrice: 5 }],
  payment: { method: "CASH" },
};

describe("flipping the counter in Settings drives the counter-sale gate", () => {
  const saved = process.env.FULFILMENT_SELF_SERVE;
  beforeEach(() => {
    resetLockState();
    process.env.FULFILMENT_SELF_SERVE = "on";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FULFILMENT_SELF_SERVE;
    else process.env.FULFILMENT_SELF_SERVE = saved;
  });

  function build() {
    const world = createWorld({ fleet: true });
    const settings = new SettingsFulfilmentService(
      world.prisma,
      world.featureConfig,
      world.store,
      world.addonService,
      world.featureOverrides,
    );
    const prisma = createMockPrisma();
    (prisma.getTenantId as jest.Mock).mockReturnValue(TENANT_ID);
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);
    const createSale = jest.fn(async () => ({
      id: "inv-1",
      orderId: "ord-1",
      invoiceNumber: "I-1",
    }));
    const orders = { createSale, findReplayCandidateByKey: jest.fn(async () => null) };
    const reader = new DefaultFulfilmentCapabilityReader(
      world.featureConfig,
      world.addonService,
      world.featureOverrides,
    );
    const counter = new CounterSaleService(
      orders as never,
      {} as never,
      {} as never,
      prisma as never,
      reader,
    );
    return { world, settings, counter, createSale, orders };
  }

  const status = async (p: Promise<unknown>) => {
    try {
      await p;
      return { ok: true } as const;
    } catch (e) {
      return {
        ok: false,
        status: (e as any).getStatus(),
        code: (e as any).getResponse().code,
      } as const;
    }
  };

  it("off -> 403 COUNTER_SALES_DISABLED; admin turns it on -> the sale rings; off again -> 403", async () => {
    const { settings, counter, createSale } = build();

    expect(await status(counter.ring(sale as never, admin))).toMatchObject({
      status: 403,
      code: "COUNTER_SALES_DISABLED",
    });
    expect(createSale).not.toHaveBeenCalled();

    const g = await settings.get(admin);
    await settings.update({ counterSales: "on", fingerprint: g.fingerprint }, admin);
    expect((await status(counter.ring(sale as never, admin))).ok).toBe(true);
    expect(createSale).toHaveBeenCalledTimes(1);

    const g2 = await settings.get(admin);
    await settings.update({ counterSales: "off", fingerprint: g2.fingerprint }, admin);
    expect(await status(counter.ring(sale as never, admin))).toMatchObject({ status: 403 });
    expect(createSale).toHaveBeenCalledTimes(1);
  });

  it("the by-key read is never a 403, with the counter off or on", async () => {
    const { settings, counter } = build();
    const off = await status(counter.byKey("some-key-123456"));
    expect(off).toMatchObject({ ok: false, status: 404 });
    const g = await settings.get(admin);
    await settings.update({ counterSales: "on", fingerprint: g.fingerprint }, admin);
    expect(await status(counter.byKey("some-key-123456"))).toMatchObject({ status: 404 });
  });
});
