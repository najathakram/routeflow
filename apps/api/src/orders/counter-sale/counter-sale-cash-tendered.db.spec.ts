/**
 * SA-764 — real-Postgres proof of the stored cash tendered (Order.counterCashTendered).
 *
 * Drives the REAL CounterSaleService (tender() under the real counter-tender advisory lock), the REAL
 * byKey read-back and the REAL CounterSaleTodayService against Postgres. Only the invoice pipeline is a
 * thin stand-in: `createSale` runs the REAL OrdersService.create() (the same `Object.create` harness as
 * counter-sale-replay.db.spec.ts) and then writes the sale's invoice + lines with stored tax rates, and
 * `recordPayment` writes a real PAID InvoicePayment. Test tenant only; collected only by jest.db.config.js
 * (`npm run local:test:db`).
 */
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import type { FulfilmentCapability } from "@routeflow/types";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { EncryptionService } from "../../common/encryption.service";
import { SystemConfigService } from "../../system-config/system-config.service";
import { OrdersService } from "../orders.service";
import type { InvoicesService } from "../../invoices/invoices.service";
import type { AuditService } from "../../audit/audit.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import type { CounterSaleDto } from "./counter-sale.dto";
import { CounterSaleService } from "./counter-sale.service";
import { CounterSaleTodayService } from "./counter-sale-today.service";
import type { WalkInCustomerService } from "./walk-in-customer";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const PRICE = "41.27";
const capability = {
  methods: ["PICKUP", "SHIP"],
  staffDefault: "PICKUP",
  staffOpensAs: "counter",
  portalMethods: [],
  portalDefault: null,
  counter: "always",
  fleet: true,
  consistent: true,
} as FulfilmentCapability;

describeDb("SA-764 — the stored cash tendered, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: OrdersService;
  let service: CounterSaleService;
  let today: CounterSaleTodayService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-cs-cash-${run}`, "counter-sale-cash-tendered.db.spec.ts");
  let tenantId = "";
  let operatorId = "";
  let customerId = "";
  let customerUserId = "";
  let productId = "";
  let invoiceSeq = 0;
  let lineRates: string[] = ["0.0825", "0.0825"];
  let failNextPayment = false;

  const staff = (): JwtPayload =>
    ({
      sub: operatorId,
      username: "operator",
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  /** The thin stand-in for OrdersService.createSale: the REAL create(), then the invoice with stored line rates. */
  const createSale = async (
    dto: { customerId: string; items: unknown[]; idempotencyKey?: string },
    user: JwtPayload,
    sale: { onReplay?: (o: unknown) => void } = {},
  ) => {
    let replayed = false;
    const order = await orders.create(
      { customerId: dto.customerId, items: dto.items, idempotencyKey: dto.idempotencyKey } as never,
      user,
      {
        skipAutoMerge: true,
        counterSale: true,
        onReplay: (existing: unknown) => {
          replayed = true;
          sale.onReplay?.(existing);
        },
      } as never,
    );
    const orderId: string = (order as { id: string }).id;
    if (!replayed) {
      await raw.order.update({ where: { id: orderId }, data: { status: "DELIVERED" } });
      const total = Number(order.total);
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-${run}-${++invoiceSeq}`,
          customerId,
          status: "SENT",
          subtotal: total,
          total,
          orderId,
          tenantId,
        },
      });
      for (const taxRate of lineRates) {
        await raw.invoiceItem.create({
          data: {
            invoiceId: invoice.id,
            description: "line",
            qty: 1,
            unitPrice: total / lineRates.length,
            subtotal: total / lineRates.length,
            taxRate,
            tenantId,
          },
        });
      }
    }
    const invoice = await raw.invoice.findFirstOrThrow({ where: { orderId } });
    return { id: invoice.id, orderId, invoiceNumber: invoice.invoiceNumber };
  };

  const recordPayment = async (
    invoiceId: string,
    dto: { amount: number; method: "CASH" | "CREDIT_CARD" | "CHECK"; reference?: string },
  ) => {
    if (failNextPayment) {
      failNextPayment = false;
      throw new Error("payment pipeline unavailable");
    }
    await raw.invoicePayment.create({
      data: {
        invoiceId,
        amount: dto.amount,
        method: dto.method,
        reference: dto.reference,
        status: "PAID",
        tenantId,
      },
    });
    return { id: invoiceId };
  };

  const ring = (payment: CounterSaleDto["payment"], key: string) =>
    tenantCtx.run(tenantId, () =>
      service.ring(
        { customerId, items: [{ productId, qty: 1 }], payment } as CounterSaleDto,
        staff(),
        key,
      ),
    );
  const stored = async (orderId: string) =>
    (await raw.order.findUniqueOrThrow({ where: { id: orderId } })).counterCashTendered;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as never),
    );
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      gateway: { emitOrderCreated: jest.fn(), emitUrgentOrder: jest.fn() },
      systemConfig,
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: { assertLinesSellable: async () => undefined },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      ledger: {},
      tenantCtx,
      logger: new Logger(OrdersService.name),
      createSale,
    });
    service = new CounterSaleService(
      orders,
      { recordPayment } as unknown as InvoicesService,
      {} as WalkInCustomerService,
      prisma,
      { get: async () => capability },
      { log: async () => undefined } as unknown as AuditService,
    );
    today = new CounterSaleTodayService(prisma);
    tenantId = (await raw.tenant.create({ data: { slug, name: `CS cash ${slug}` } })).id;
    operatorId = (
      await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      })
    ).id;
    customerUserId = (
      await raw.user.create({
        data: { email: `c-${run}@example.test`, username: `c-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId: customerUserId, businessName: "cs cash co", contactName: "T", tenantId },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `plain ${run}`,
          unit: "each",
          pricePerUnit: PRICE,
          currentStock: 1000,
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  /** Everything one throwaway tenant owns here, deleted children-first (what the first tenant's afterAll always did). */
  const purge = async (t: {
    tenantId: string;
    productId: string;
    customerId: string;
    users: string[];
  }) => {
    const ids = (
      await raw.order.findMany({ where: { tenantId: t.tenantId }, select: { id: true } })
    ).map((o) => o.id);
    const invoiceIds = (
      await raw.invoice.findMany({ where: { orderId: { in: ids } }, select: { id: true } })
    ).map((i) => i.id);
    await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.orderIdempotencyKey.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await raw.stockMovement.deleteMany({ where: { productId: t.productId } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await raw.order.deleteMany({ where: { id: { in: ids } } });
    await raw.product.deleteMany({ where: { id: t.productId } });
    await raw.customer.deleteMany({ where: { id: t.customerId } });
    await raw.systemConfig.deleteMany({ where: { tenantId: t.tenantId } });
    await raw.user.deleteMany({ where: { id: { in: t.users } } });
    await raw.tenant.deleteMany({ where: { id: t.tenantId } });
  };
  let other: { tenantId: string; productId: string; customerId: string; users: string[] } | null =
    null;

  afterAll(async () => {
    if (other) await purge(other);
    await purge({ tenantId, productId, customerId, users: [operatorId, customerUserId] });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  const cashKey = `cs-cash-${randomUUID()}`;
  const cardKey = `cs-card-${randomUUID()}`;
  const mixedKey = `cs-mixed-${randomUUID()}`;
  let cashOrderId = "";
  let cardOrderId = "";

  it("(1) a new CASH sale tendering 50 on 41.27 stores 50.00", async () => {
    const r = await ring({ method: "CASH", amount: 50 }, cashKey);
    cashOrderId = r.orderId;
    expect(r.total).toBe(41.27);
    expect(r.change).toBe(8.73);
    expect(Number(await stored(cashOrderId))).toBe(50);
  }, 60_000);

  it("(2) a same-key replay and a later tender with a DIFFERENT amount leave it at 50.00", async () => {
    await ring({ method: "CASH", amount: 60 }, cashKey);
    expect(Number(await stored(cashOrderId))).toBe(50);
    await tenantCtx.run(tenantId, () =>
      (
        service as unknown as {
          tender: (dto: unknown, orderId: string) => Promise<unknown>;
        }
      ).tender({ payment: { method: "CASH", amount: 70 } }, cashOrderId),
    );
    expect(Number(await stored(cashOrderId))).toBe(50);
    // the DB filter itself: a direct write behind the NULL guard changes nothing
    const direct = await raw.order.updateMany({
      where: { id: cashOrderId, counterCashTendered: null },
      data: { counterCashTendered: 99 },
    });
    expect(direct.count).toBe(0);
  }, 60_000);

  it("(3) a CARD sale leaves it NULL", async () => {
    const r = await ring({ method: "CARD" }, cardKey);
    cardOrderId = r.orderId;
    expect(await stored(cardOrderId)).toBeNull();
  }, 60_000);

  it("(4) byKey returns cashTendered 50 for the cash sale and omits it for the card sale", async () => {
    const cash = await tenantCtx.run(tenantId, () => service.byKey(cashKey));
    expect(cash.cashTendered).toBe(50);
    const card = await tenantCtx.run(tenantId, () => service.byKey(cardKey));
    expect(card.cashTendered).toBeUndefined();
  }, 60_000);

  it("(5) the Today's-sales rows carry cashTendered and taxRatePercent from the stored line rates (8.25; null when mixed)", async () => {
    lineRates = ["0.0825", "0.0600"];
    const mixed = await ring({ method: "CARD" }, mixedKey);
    const res = await tenantCtx.run(tenantId, () => today.today({} as never));
    const row = (id: string) => res.data.find((d) => d.orderId === id)!;
    expect(row(cashOrderId).cashTendered).toBe(50);
    expect(row(cashOrderId).taxRatePercent).toBe(8.25);
    expect(row(cardOrderId).cashTendered).toBeNull();
    expect(row(cardOrderId).taxRatePercent).toBe(8.25);
    expect(row(mixed.orderId).taxRatePercent).toBeNull();
  }, 60_000);

  it("(6) a first attempt whose payment fails, retried on the SAME key with a new amount, stores the NEW amount and its change", async () => {
    const key = `cs-retry-${randomUUID()}`;
    failNextPayment = true;
    const first = await ring({ method: "CASH", amount: 50 }, key);
    expect(first.paymentRecorded).toBe(false);
    expect(first.paymentErrorCode).toBe("COUNTER_PAYMENT_NOT_RECORDED");
    expect(Number(await stored(first.orderId))).toBe(50);
    const retry = await ring({ method: "CASH", amount: 60 }, key);
    expect(retry.orderId).toBe(first.orderId);
    expect(retry.paymentRecorded).toBe(true);
    expect(Number(await stored(first.orderId))).toBe(60);
    expect(retry.cashTendered).toBe(60);
    expect(retry.change).toBe(18.73);
    // now anchored by a CASH row: frozen against a further replay, and every read agrees
    const again = await ring({ method: "CASH", amount: 90 }, key);
    expect(Number(await stored(first.orderId))).toBe(60);
    expect(again.change).toBe(18.73);
    const byKey = await tenantCtx.run(tenantId, () => service.byKey(key));
    expect(byKey.change).toBe(18.73);
    const res = await tenantCtx.run(tenantId, () => today.today({} as never));
    expect(res.data.find((d) => d.orderId === first.orderId)!.change).toBe(18.73);
  }, 60_000);

  it("(7) another tenant's cash sale is absent from this tenant's Today rows and its key is a 404 here", async () => {
    const mine = { tenantId, productId, customerId, operatorId, customerUserId };
    const otherSlug = assertTestTenant(
      `qa-cs-cash-${run}b`,
      "counter-sale-cash-tendered.db.spec.ts",
    );
    const otherKey = `cs-other-${randomUUID()}`;
    const t = await raw.tenant.create({ data: { slug: otherSlug, name: `CS cash ${otherSlug}` } });
    const uOp = await raw.user.create({
      data: {
        email: `op-${run}b@example.test`,
        username: `op-${run}b`,
        role: "OPERATOR",
        tenantId: t.id,
      },
    });
    const uCust = await raw.user.create({
      data: {
        email: `c-${run}b@example.test`,
        username: `c-${run}b`,
        role: "CUSTOMER",
        tenantId: t.id,
      },
    });
    const cust = await raw.customer.create({
      data: { userId: uCust.id, businessName: "cs cash other", contactName: "T", tenantId: t.id },
    });
    const prod = await raw.product.create({
      data: {
        name: `plain ${run}b`,
        unit: "each",
        pricePerUnit: PRICE,
        currentStock: 1000,
        tenantId: t.id,
      },
    });
    other = { tenantId: t.id, productId: prod.id, customerId: cust.id, users: [uOp.id, uCust.id] };
    let foreignOrderId = "";
    try {
      // ring in the OTHER tenant (the harness reads these closure ids), then restore ours
      tenantId = t.id;
      customerId = cust.id;
      productId = prod.id;
      operatorId = uOp.id;
      foreignOrderId = (await ring({ method: "CASH", amount: 50 }, otherKey)).orderId;
      expect(Number(await stored(foreignOrderId))).toBe(50);
    } finally {
      ({ tenantId, productId, customerId, operatorId, customerUserId } = mine);
    }
    const res = await tenantCtx.run(tenantId, () => today.today({} as never));
    expect(res.data.some((d) => d.orderId === foreignOrderId)).toBe(false);
    await expect(tenantCtx.run(tenantId, () => service.byKey(otherKey))).rejects.toMatchObject({
      status: 404,
    });
  }, 90_000);
});
