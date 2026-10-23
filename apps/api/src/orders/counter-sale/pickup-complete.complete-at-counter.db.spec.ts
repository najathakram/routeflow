/**
 * I-120 "Complete at counter" (SA-861) on real Postgres, through the REAL OrdersService.changeStatus and the REAL
 * path switch (updateFulfillPath), with the customer-message collaborators as spies:
 *  - D1 (R1): a PENDING ROUTE order not on any run -> path PICKUP, status DELIVERED, the invoice issued quietly, ZERO
 *        pushes and ZERO messaging events, ONE completion email, and no stock movement (stock was taken at PENDING).
 *        Master: 400 PICKUP_ONLY (observe).
 *  - D5 (R5): a replay with the same key after the email went: no second email, no second status write, alreadyPickedUp.
 *  - D7 (R7): the store's state refuses a line at the switch (L8) -> 409, and nothing is written: path, status and the
 *        invoice are unchanged, no email.
 * The tender and the completion email are spies here (their rules are pinned by pickup-complete.complete-at-counter.spec.ts).
 *
 * The DB lane runs it (`npm run local:test:db`, test tenants only). One throwaway `qa-i120-<run>` tenant; `afterAll` deletes
 * exactly the rows this run created.
 */
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { PickupCompleteService } from "./pickup-complete.service";
import { buildDbOrdersService } from "../../common/testing/orders-service-db-harness";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

describeDb("I-120 Complete at counter — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-i120-${run}`, "pickup-complete.complete-at-counter.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let customerId = "";
  let productId = "";
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  let n = 0;
  const pushes = jest.fn(async () => undefined);
  const events = jest.fn(async () => undefined);
  const email = jest.fn(async () => ({ delivered: true }));
  const sent: string[] = [];
  let restricted = false;
  const operator = () =>
    ({
      sub: userId,
      email: `o-${run}@example.test`,
      username: `o-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;
  const as = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const storePickup = {
    get: async () => ({ methods: ["ROUTE", "SHIP", "PICKUP"], counter: "off" }) as never,
  };

  /** A PENDING / CONFIRMED order with one line and its DRAFT invoice (total 0: nothing owed, no tender). */
  async function seed(
    status: string,
    fulfillPath: "ROUTE" | "SHIP" | "PICKUP",
    over: { total?: number; customerId?: string } = {},
  ) {
    n += 1;
    const total = String(over.total ?? 0);
    const order = await raw.order.create({
      data: {
        customerId: over.customerId ?? customerId,
        tenantId,
        status: status as never,
        fulfillPath: fulfillPath as never,
        orderNumber: `I120-${run}-${n}`,
        subtotal: total,
        total,
      },
    });
    orderIds.push(order.id);
    await raw.orderItem.create({
      data: { orderId: order.id, productId, tenantId, qty: 2, unitPrice: 0, subtotal: 0 },
    });
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `INV-I120-${run}-${n}`,
        customerId: over.customerId ?? customerId,
        orderId: order.id,
        tenantId,
        status: "DRAFT",
        subtotal: Number(total),
        total: Number(total),
      },
    });
    invoiceIds.push(invoice.id);
    return { orderId: order.id, invoiceId: invoice.id };
  }
  const engine = () =>
    new PickupCompleteService(orders, orders.invoicesService, prisma, storePickup as never);
  const complete = (orderId: string) =>
    as(() => engine().complete(orderId, {} as never, operator(), `key-${run}-${n}`));

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    orders = buildDbOrdersService(prisma, tenantCtx, {
      pushes,
      events,
      assertLinesSellable: async () => {
        if (restricted)
          throw new ConflictException({ code: "SELLING_RESTRICTED", message: "restricted" });
      },
      invoices: {
        send: async (id: string, opts?: { suppressNotify?: boolean }) => {
          sent.push(`${id}:${opts?.suppressNotify === true ? "quiet" : "notify"}`);
          await raw.invoice.update({ where: { id }, data: { status: "SENT" } });
          return { status: "SENT" };
        },
        recordPayment: jest.fn(),
        sendCompletionEmail: email,
      },
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `I120 ${slug}` } })).id;
    userId = (
      await raw.user.create({
        data: { email: `o-${run}@example.test`, username: `o-${run}`, role: "OPERATOR", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: {
          userId,
          businessName: `Acme Test ${run}`,
          contactName: "Tester",
          email: `buyer-${run}@example.test`,
          tenantId,
        },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Widget ${run}`,
          unit: "ea",
          pricePerUnit: "0.00",
          currentStock: "100",
          tenantId,
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    try {
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.systemConfig.deleteMany({ where: { tenantId } });
      await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.delete({ where: { id: tenantId } });
    } finally {
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  });

  beforeEach(() => {
    pushes.mockClear();
    events.mockClear();
    email.mockClear();
    sent.length = 0;
    restricted = false;
  });

  it("D1 (R1) a PENDING ROUTE order: PICKUP + DELIVERED, a quiet invoice, 0 pushes, 0 events, 1 email, no stock moved", async () => {
    const { orderId, invoiceId } = await seed("PENDING", "ROUTE");
    const stockBefore = Number(
      (await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock,
    );
    await complete(orderId);
    await new Promise((r) => setImmediate(r)); // any fire-and-forget message would have been queued by now
    const after = await raw.order.findUniqueOrThrow({ where: { id: orderId } });
    expect({ path: after.fulfillPath, status: after.status }).toEqual({
      path: "PICKUP",
      status: "DELIVERED",
    });
    expect(sent).toEqual([`${invoiceId}:quiet`]);
    expect(pushes).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(email).toHaveBeenCalledTimes(1);
    expect(
      Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock),
    ).toBe(stockBefore);
  }, 60_000);

  it("D5 (R5) a replay with the same key after the email went: no second email, alreadyPickedUp, the order unchanged", async () => {
    const { orderId } = await seed("CONFIRMED", "PICKUP");
    const key = `key-${run}-d5`;
    const first = await as(() => engine().complete(orderId, {} as never, operator(), key));
    const deliveredAt = (await raw.order.findUniqueOrThrow({ where: { id: orderId } })).deliveredAt;
    const again: any = await as(() => engine().complete(orderId, {} as never, operator(), key));
    expect((first as any).emailed).toBe(true);
    expect(again.alreadyPickedUp).toBe(true);
    expect(again.emailed ?? false).toBe(false);
    expect(email).toHaveBeenCalledTimes(1);
    const claim = await raw.auditLog.findFirst({
      where: { tenantId, entityId: orderId, action: "PICKUP_COMPLETE_CLAIM" },
    });
    expect((claim?.meta as any)?.completionEmailedAt).toBeTruthy();
    expect((await raw.order.findUniqueOrThrow({ where: { id: orderId } })).deliveredAt).toEqual(
      deliveredAt,
    );
  }, 60_000);

  it("D7 (R7) the store's state refuses a line at the switch: 409, path / status / invoice unchanged, no email", async () => {
    const { orderId, invoiceId } = await seed("CONFIRMED", "ROUTE");
    restricted = true;
    const err: any = await complete(orderId).catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    const after = await raw.order.findUniqueOrThrow({ where: { id: orderId } });
    expect({ path: after.fulfillPath, status: after.status }).toEqual({
      path: "ROUTE",
      status: "CONFIRMED",
    });
    expect((await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      "DRAFT",
    );
    expect(email).not.toHaveBeenCalled();
  }, 60_000);

  // SA-905 MUST 1: the delivery credit gate (B585, netted) is judged BEFORE the first write. Head: the refusal came at the
  // DELIVERED step, after the switch to Store pickup and the silent PENDING -> CONFIRMED had committed.
  it("M1 enforce_delivery ON, an over-limit customer, a PENDING ROUTE order on account: 409 with path ROUTE, status PENDING, nothing sent", async () => {
    await raw.customer.update({ where: { id: customerId }, data: { creditLimit: "50" } });
    await raw.systemConfig.create({
      data: { tenantId, key: "credit_limit.enforce_delivery", value: "true" },
    });
    try {
      const { orderId, invoiceId } = await seed("PENDING", "ROUTE", { total: 100 });
      const err: any = await complete(orderId).catch((e) => e);
      expect(err?.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: "CREDIT_LIMIT_EXCEEDED" });
      const after = await raw.order.findUniqueOrThrow({ where: { id: orderId } });
      expect({ path: after.fulfillPath, status: after.status }).toEqual({
        path: "ROUTE",
        status: "PENDING",
      });
      expect((await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
        "DRAFT",
      );
      expect(sent).toEqual([]);
      expect(email).not.toHaveBeenCalled();
    } finally {
      await raw.systemConfig.deleteMany({
        where: { tenantId, key: "credit_limit.enforce_delivery" },
      });
      await raw.customer.update({ where: { id: customerId }, data: { creditLimit: null } });
    }
  }, 60_000);

  // SA-905 MUST 2 (a): a different key after an on-account completion (no hand-over tender, so the claim is replaced) must
  // not erase the email flag. Head: the replacement dropped completionEmailedAt and a second email went.
  it("M2a an on-account completion, then a request with a DIFFERENT key: no second email", async () => {
    const { orderId } = await seed("PENDING", "ROUTE");
    await as(() => engine().complete(orderId, {} as never, operator(), `key-${run}-m2a-1`));
    await as(() => engine().complete(orderId, {} as never, operator(), `key-${run}-m2a-2`));
    expect(email).toHaveBeenCalledTimes(1);
  }, 60_000);

  // SA-905 MUST 2 (b): two concurrent same-key calls (a client retry while the first is still sending) send exactly once.
  it("M2b two concurrent same-key calls, the send slow: exactly 1 email", async () => {
    const { orderId } = await seed("CONFIRMED", "PICKUP");
    email.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { delivered: true };
    });
    try {
      const key = `key-${run}-m2b`;
      const results = await Promise.allSettled([
        as(() => engine().complete(orderId, {} as never, operator(), key)),
        as(() => engine().complete(orderId, {} as never, operator(), key)),
      ]);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      expect(email).toHaveBeenCalledTimes(1);
    } finally {
      email.mockImplementation(async () => ({ delivered: true }));
    }
  }, 60_000);
});
