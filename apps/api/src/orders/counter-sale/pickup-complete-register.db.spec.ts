/**
 * SA-750r3 (Train 4 meets day close) - a POS-mode (non-counter) PICKUP hand-over counts on a till register, on real Postgres:
 *   - an order with no `registerKey` is STAMPED with the request's register under the shared close lock, before its payment;
 *   - a stamped order is NEVER overwritten: the tender counts toward the stamped register whatever the request says;
 *   - a hand-over whose register has a close in force over the database-clock instant is a 409 COUNTER_SALE_DAY_CLOSED against a
 *     REAL CounterDayClose row, with the order left unstamped and no payment row; another register's tender is unaffected.
 *
 * Collaborators other than Prisma/the advisory lock are stand-ins: `changeStatus` / `send` / `recordPayment` write the same rows
 * the real ones would (status, deliveredAt, an InvoicePayment with the tender's group id and paidAt).
 *
 * NOT RUN by the authoring lane (no Postgres here): the DB lane runs it (`npm run local:test:db`, test tenants only, collected only
 * by jest.db.config.js). Tenant slugs `qa-day-close-*` are approved by assertTestTenant.
 */
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../order-status-invoicing", () => ({ settleOrderInvoice: jest.fn() }));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { PickupCompleteService } from "./pickup-complete.service";
import { pickupTenderGroupId } from "./pickup-tender-group";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

describeDb("a POS-mode pickup hand-over counts on a register, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: PickupCompleteService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(
    `qa-day-close-pickup-${run}`,
    "pickup-complete-register.db.spec.ts",
  );
  let tenantId = "";
  let operator!: JwtPayload;
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  let seq = 0;

  const CLOSED = `rc-${run}`; // a register with a close in force around "now"
  const OPEN = `ro-${run}`;

  /** A non-counter PICKUP order, "Ready for pickup", with one DRAFT invoice of 20.00. */
  async function pickupOrder(registerKey: string | null) {
    seq += 1;
    const user = await raw.user.create({
      data: {
        email: `c-${seq}-${run}@example.test`,
        username: `c-${seq}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(user.id);
    const customer = await raw.customer.create({
      data: { userId: user.id, businessName: `Acme Test ${seq}`, contactName: "Tester", tenantId },
    });
    customerIds.push(customer.id);
    const order = await raw.order.create({
      data: {
        customerId: customer.id,
        tenantId,
        counterSale: false,
        fulfillPath: "PICKUP",
        registerKey,
        status: "OUT_FOR_DELIVERY",
        orderNumber: `P${run}-${seq}`,
        total: 20,
      },
    });
    orderIds.push(order.id);
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `PINV-${run}-${seq}`,
        customerId: customer.id,
        orderId: order.id,
        tenantId,
        status: "DRAFT",
        subtotal: 20,
        total: 20,
      },
    });
    invoiceIds.push(invoice.id);
    return { orderId: order.id, invoiceId: invoice.id };
  }

  const handOver = (orderId: string, registerKey?: string) =>
    tenantCtx.run(tenantId, () =>
      service.complete(
        orderId,
        { payment: { method: "CASH", amount: 20 }, registerKey } as never,
        operator,
        `key-${orderId}`,
      ),
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 10 });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    tenantId = (await raw.tenant.create({ data: { slug, name: `Pickup register ${slug}` } })).id;
    await raw.tenantConfig.create({ data: { tenantId, timezone: "America/New_York" } });
    const op = await raw.user.create({
      data: { email: `op-${run}@example.test`, username: `op-${run}`, role: "OPERATOR", tenantId },
    });
    userIds.push(op.id);
    operator = { sub: op.id, username: op.username, role: "OPERATOR", tenantId } as never;

    service = new PickupCompleteService(
      {
        changeStatus: async (id: string) =>
          raw.order.update({
            where: { id },
            data: { status: "DELIVERED", deliveredAt: new Date() },
          }),
      } as never,
      {
        send: async (id: string) => raw.invoice.update({ where: { id }, data: { status: "SENT" } }),
        recordPayment: async (invoiceId: string, dto: any, opts: any) =>
          raw.invoicePayment.create({
            data: {
              invoiceId,
              tenantId,
              amount: dto.amount,
              method: dto.method,
              status: "PAID",
              paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
              paymentGroupId: opts?.paymentGroupId ?? null,
            },
          }),
      } as never,
      prisma,
    );

    // A close in force over "now" for ONE register: its window runs from two hours ago to an hour ahead.
    const now = Date.now();
    await raw.counterDayClose.create({
      data: {
        tenantId,
        registerKey: CLOSED,
        day: new Date(now),
        zone: "America/New_York",
        windowStart: new Date(now - 2 * 3_600_000),
        windowEnd: new Date(now + 3_600_000),
        closedAt: new Date(now - 60_000),
        closedById: op.id,
        openingFloat: 0,
        expectedCash: 0,
        countedCash: 0,
        variance: 0,
        denominations: [],
        totals: {},
      },
    });
  }, 120_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.counterDayClose.deleteMany({ where: { tenantId } });
    await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenantConfig.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("stamps a null Order.registerKey with the request's register, and the tender carries the pickup group id", async () => {
    const o = await pickupOrder(null);
    const res = await handOver(o.orderId, OPEN);
    expect(res).toMatchObject({ paymentRecorded: true, paid: 20 });
    const order = await raw.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order.registerKey).toBe(OPEN);
    const pays = await raw.invoicePayment.findMany({ where: { invoiceId: o.invoiceId } });
    expect(pays).toHaveLength(1);
    expect(pays[0].paymentGroupId).toBe(pickupTenderGroupId(o.orderId));
  });

  it("with no request key and none stamped the order is stamped 'main'", async () => {
    const o = await pickupOrder(null);
    await handOver(o.orderId);
    expect((await raw.order.findUniqueOrThrow({ where: { id: o.orderId } })).registerKey).toBe(
      "main",
    );
  });

  it("never overwrites a stamped register: the tender counts toward the stamp, whatever the request says", async () => {
    const o = await pickupOrder(OPEN);
    await handOver(o.orderId, `other-${run}`);
    expect((await raw.order.findUniqueOrThrow({ where: { id: o.orderId } })).registerKey).toBe(
      OPEN,
    );
    expect(await raw.invoicePayment.count({ where: { invoiceId: o.invoiceId } })).toBe(1);
  });

  it("a stamped register with a close in force is 409 COUNTER_SALE_DAY_CLOSED; request keys cannot dodge it", async () => {
    const o = await pickupOrder(CLOSED);
    const err: any = await handOver(o.orderId, OPEN).catch((e) => e);
    expect(err.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
    expect(await raw.invoicePayment.count({ where: { invoiceId: o.invoiceId } })).toBe(0);
    expect((await raw.order.findUniqueOrThrow({ where: { id: o.orderId } })).registerKey).toBe(
      CLOSED,
    );
  });

  it("an unstamped order handed over into a closed register is 409, left unstamped, with no payment row", async () => {
    const o = await pickupOrder(null);
    const err: any = await handOver(o.orderId, CLOSED).catch((e) => e);
    expect(err.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
    expect(await raw.invoicePayment.count({ where: { invoiceId: o.invoiceId } })).toBe(0);
    expect(
      (await raw.order.findUniqueOrThrow({ where: { id: o.orderId } })).registerKey,
    ).toBeNull();
  });
});
