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
import { AUDIT_ACTIONS } from "../../audit/audit-actions.constant";
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
  const recordPayment = jest.fn();
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
        recordPayment,
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
      await raw.counterDayClose.deleteMany({ where: { tenantId } });
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
    recordPayment.mockReset();
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
    expect((claim?.meta as any)?.completionEmailedFor).toBeTruthy(); // SA-909: per completion
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

  // #3678 review MUST (P3a, real creditAfterTender): the hand-over's after-tender re-check reads the DELIVERY switch, the
  // gate that netted the tender. Head: it read enforce_new_orders, so with enforce_delivery alone the customer left over the
  // limit on account and nothing was raised.
  it("P3a enforce_delivery ON only: a netted CASH tender that fails leaves the customer over the limit: creditOverLimit + 1 audit row", async () => {
    await raw.customer.update({ where: { id: customerId }, data: { creditLimit: "50" } });
    await raw.systemConfig.create({
      data: { tenantId, key: "credit_limit.enforce_delivery", value: "true" },
    });
    try {
      const { orderId } = await seed("CONFIRMED", "PICKUP", { total: 100 });
      recordPayment.mockRejectedValue(new Error("payment-ref 503"));
      const r: any = await as(() =>
        engine().complete(
          orderId,
          { payment: { method: "CASH", amount: 100 } } as never,
          operator(),
          `key-${run}-p3a`,
        ),
      );
      expect(r.paymentRecorded).toBe(false);
      // the customer is shared across cases (an earlier case left a $100 pending order), so exposure is judged, not pinned
      expect(r.creditOverLimit).toMatchObject({ limit: 50 });
      expect(r.creditOverLimit.exposure).toBeGreaterThan(50);
      expect(
        await raw.auditLog.count({
          where: { tenantId, entityId: orderId, action: "credit-limit.over-after-tender" },
        }),
      ).toBe(1);
    } finally {
      await raw.systemConfig.deleteMany({
        where: { tenantId, key: "credit_limit.enforce_delivery" },
      });
      await raw.customer.update({ where: { id: customerId }, data: { creditLimit: null } });
    }
  }, 60_000);

  // ── SA-909 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const claimOf = (orderId: string) =>
    raw.auditLog.findFirstOrThrow({
      where: { tenantId, entityId: orderId, action: "PICKUP_COMPLETE_CLAIM" },
    });
  const emailsFor = (orderId: string) =>
    email.mock.calls.filter((c: any[]) => c[0] === orderId).length;

  // Item 1: a closed day is refused BEFORE the first write (head: PICKUP / DELIVERED / SENT with no payment).
  it("S1 a CLOSED window, a ROUTE order with CASH: 409 COUNTER_SALE_DAY_CLOSED, path ROUTE, status unchanged, nothing sent", async () => {
    const now = new Date();
    await raw.counterDayClose.create({
      data: {
        tenantId,
        registerKey: "main",
        day: now,
        zone: "UTC",
        windowStart: new Date(now.getTime() - 3_600_000),
        windowEnd: new Date(now.getTime() + 3_600_000),
        closedAt: now,
        expectedCash: 0,
        countedCash: 0,
        variance: 0,
        denominations: {},
        totals: {},
      },
    });
    try {
      const { orderId, invoiceId } = await seed("CONFIRMED", "ROUTE", { total: 10 });
      const err: any = await as(() =>
        engine().complete(
          orderId,
          { payment: { method: "CASH", amount: 10 } } as never,
          operator(),
          `key-${run}-s1`,
        ),
      ).catch((e) => e);
      expect(err?.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
      const after = await raw.order.findUniqueOrThrow({ where: { id: orderId } });
      expect({ path: after.fulfillPath, status: after.status }).toEqual({
        path: "ROUTE",
        status: "CONFIRMED",
      });
      expect((await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
        "DRAFT",
      );
      expect(sent).toEqual([]);
      expect(email).not.toHaveBeenCalled();
    } finally {
      await raw.counterDayClose.deleteMany({ where: { tenantId } });
    }
  }, 60_000);

  // Item 2: the flag is per COMPLETION (head: completionEmailedAt lived for the order's lifetime, so a re-completion after a
  // reopen sent nothing).
  it("S2 complete, reopen, re-complete: 2 emails in all (a different key on the same completion still sends none)", async () => {
    const { orderId } = await seed("CONFIRMED", "PICKUP");
    await as(() => engine().complete(orderId, {} as never, operator(), `key-${run}-s2a`));
    await as(() => engine().complete(orderId, {} as never, operator(), `key-${run}-s2b`)); // same completion
    expect(emailsFor(orderId)).toBe(1);
    await as(() =>
      orders.changeStatus(
        orderId,
        { status: "CONFIRMED", reason: "I-120 S2 reopen" } as never,
        operator(),
      ),
    );
    await new Promise((r) => setTimeout(r, 15)); // a new deliveredAt for the re-completion
    await as(() => engine().complete(orderId, {} as never, operator(), `key-${run}-s2c`));
    expect(emailsFor(orderId)).toBe(2);
  }, 60_000);

  // Item 3: a crash after the reservation is honoured within the lease and taken over after it.
  it("S3 a reservation left by a crashed sender: honoured inside the lease (no send), taken over after it (one send)", async () => {
    const { orderId } = await seed("CONFIRMED", "PICKUP");
    email.mockResolvedValueOnce({ delivered: false }); // the first send fails: the reservation is released, no flag
    const key = `key-${run}-s3`;
    await as(() => engine().complete(orderId, {} as never, operator(), key));
    const claim = await claimOf(orderId);
    const deliveredAt = (await raw.order.findUniqueOrThrow({ where: { id: orderId } }))
      .deliveredAt!;
    const crash = (at: Date) =>
      raw.auditLog.update({
        where: { id: claim.id },
        data: {
          meta: {
            ...(claim.meta as object),
            completionEmailClaim: { for: deliveredAt.toISOString(), at: at.toISOString() },
          },
        },
      });
    email.mockClear();
    await crash(new Date()); // a sender reserved, then died
    await as(() => engine().complete(orderId, {} as never, operator(), key));
    expect(email).not.toHaveBeenCalled();
    await crash(new Date(Date.now() - 11 * 60_000)); // past the 10-minute lease
    await as(() => engine().complete(orderId, {} as never, operator(), key));
    expect(email).toHaveBeenCalledTimes(1);
  }, 60_000);

  // Item 4: the send record is the delivery fact when the flag never got written (markSent threw after the send).
  it("S4 the send went but markSent threw: the retry sends NO second email, and the flag gets written", async () => {
    const { orderId, invoiceId } = await seed("CONFIRMED", "PICKUP");
    email.mockImplementationOnce(async () => {
      await raw.auditLog.create({
        data: {
          tenantId,
          userId,
          action: AUDIT_ACTIONS.INVOICE_EMAILED,
          entityType: "invoice",
          entityId: invoiceId,
          meta: { kind: "COUNTER_COMPLETE", to: "buyer@example.test", fp: null },
        },
      });
      throw new Error("markSent failed");
    });
    const key = `key-${run}-s4`;
    await as(() => engine().complete(orderId, {} as never, operator(), key));
    await as(() => engine().complete(orderId, {} as never, operator(), key));
    expect(email).toHaveBeenCalledTimes(1);
    expect(((await claimOf(orderId)).meta as any)?.completionEmailedFor).toBeTruthy();
  }, 60_000);

  // Item 3: no counter-tender slot is held across the send (head: one slot per stalled send, 4 slots in all).
  it("S5 four stalled completion sends do not starve a till tender on another order (no LockUnavailable)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const guard = setTimeout(() => release(), 30_000); // never hang the lane
    email.mockImplementation(async () => {
      await gate;
      return { delivered: true };
    });
    try {
      const stalled: Promise<unknown>[] = [];
      for (let i = 0; i < 4; i++) {
        const { orderId } = await seed("CONFIRMED", "PICKUP");
        stalled.push(
          as(() => engine().complete(orderId, {} as never, operator(), `key-${run}-s5-${i}`)),
        );
      }
      await new Promise((r) => setTimeout(r, 500)); // all four are inside their send
      const { orderId: tillOrder } = await seed("CONFIRMED", "PICKUP", { total: 10 });
      recordPayment.mockImplementation(async (invoiceId: string, dto: any) => {
        await raw.invoicePayment.create({
          data: {
            invoiceId,
            tenantId,
            amount: dto.amount,
            method: dto.method,
            status: "PAID",
            paidAt: new Date(),
          },
        });
        return { id: invoiceId };
      });
      const till: any = await as(() =>
        engine().complete(
          tillOrder,
          { payment: { method: "CASH", amount: 10 } } as never,
          operator(),
          `key-${run}-s5-till`,
        ),
      );
      expect(till.paymentErrorCode).not.toBe("COUNTER_PAYMENT_NOT_RECORDED");
      expect(till.paymentRecorded).toBe(true);
      release();
      await Promise.all(stalled);
    } finally {
      clearTimeout(guard);
      release();
      email.mockImplementation(async () => ({ delivered: true }));
    }
  }, 90_000);
});
