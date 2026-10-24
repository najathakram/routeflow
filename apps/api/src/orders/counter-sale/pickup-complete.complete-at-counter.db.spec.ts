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
import { claimStopStatusChangeOnLiveRun } from "../../routes/delivery-lines.util";
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
  let lastAck: unknown = null;
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
  const routeProgress = jest.fn();
  const engine = () =>
    // the 5th (optional) arg is the gateway the take-off's skipped-stop update goes through
    new (PickupCompleteService as any)(
      orders,
      orders.invoicesService,
      prisma,
      storePickup as never,
      {
        emitRouteProgress: routeProgress,
      } as never,
    );
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
      // W-773: the judgement sees the request's acknowledgement; an acknowledged override passes
      assertLinesSellable: (async (p?: { ack?: any }) => {
        lastAck = p?.ack ?? null;
        if (restricted && !p?.ack?.restrictionOverrides?.length)
          throw new ConflictException({ code: "SELLING_RESTRICTED", message: "restricted" });
      }) as never,
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
      await raw.routeRunStop.deleteMany({ where: { tenantId } });
      await raw.routeRun.deleteMany({ where: { tenantId } });
      await raw.routeStop.deleteMany({ where: { tenantId } });
      await raw.route.deleteMany({ where: { tenantId } });
      await raw.driver.deleteMany({ where: { tenantId } });
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
    routeProgress.mockClear();
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
      // #3678 Opus NIT: nothing owed records no tender, so the same CLOSED window does not refuse it (head: 409)
      const owesNothing = await seed("CONFIRMED", "ROUTE");
      await as(() =>
        engine().complete(
          owesNothing.orderId,
          { payment: { method: "CASH", amount: 10 } } as never,
          operator(),
          `key-${run}-s1b`,
        ),
      );
      expect(
        (await raw.order.findUniqueOrThrow({ where: { id: owesNothing.orderId } })).status,
      ).toBe("DELIVERED");
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
  // W-776 (SA-925): the pre-check's refusal has its OWN code (head: COUNTER_SALE_DAY_CLOSED, which the clients read as "handed over").
  for (const [from, path] of [
    ["CONFIRMED", "ROUTE"],
    ["PENDING", "PICKUP"],
  ] as const)
    it(`S1 a CLOSED window, a ${from} ${path} order with CASH: 409 COUNTER_COMPLETE_DAY_CLOSED, path and status unchanged, no claim, nothing sent`, async () => {
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
        const { orderId, invoiceId } = await seed(from, path, { total: 10 });
        const err: any = await as(() =>
          engine().complete(
            orderId,
            { payment: { method: "CASH", amount: 10 } } as never,
            operator(),
            `key-${run}-s1-${from}`,
          ),
        ).catch((e) => e);
        expect(err?.getStatus?.()).toBe(409);
        expect(err.getResponse()).toMatchObject({ code: "COUNTER_COMPLETE_DAY_CLOSED" });
        const after = await raw.order.findUniqueOrThrow({ where: { id: orderId } });
        expect({
          path: after.fulfillPath,
          status: after.status,
          delivered: after.deliveredAt,
        }).toEqual({
          path,
          status: from,
          delivered: null,
        });
        expect(
          await raw.auditLog.count({
            where: { tenantId, entityId: orderId, action: "PICKUP_COMPLETE_CLAIM" },
          }),
        ).toBe(0);
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
    // SA-919: the completion is keyed on the claim's completionAt (never deliveredAt)
    const completionAt: string = (claim.meta as any).completionAt;
    const crash = (at: Date) =>
      raw.auditLog.update({
        where: { id: claim.id },
        data: {
          meta: {
            ...(claim.meta as object),
            completionEmailClaim: { for: completionAt, at: at.toISOString() },
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

  // ── SA-919 (the #3678 Opus MUST, P13): THIS completion's tender = a row of the order's hand-over group created at or after
  // the claim's completionAt; its email is keyed on completionAt too. Head keyed both on deliveredAt, which DELIVERED sets to a
  // backdated order's orderDate: a deposit taken after the order date counted as counter tender.
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
  /** recordPayment writes a real PAID row, the tender's group id included, so the stored rows are what is read back. */
  const recordForReal = () =>
    recordPayment.mockImplementation(async (invoiceId: string, dto: any, opts: any) =>
      raw.invoicePayment.create({
        data: {
          invoiceId,
          amount: dto.amount,
          method: dto.method,
          tenantId,
          paymentGroupId: opts?.paymentGroupId ?? null,
        },
      }),
    );
  const amountsOf = async (invoiceId: string, tenderOnly = false) =>
    (
      await raw.invoicePayment.findMany({
        where: { invoiceId, ...(tenderOnly ? { paymentGroupId: { not: null } } : {}) },
        orderBy: { createdAt: "asc" },
      })
    ).map((p) => Number(p.amount));
  const completeWith = (orderId: string, amount: number, key: string) =>
    as(() =>
      engine().complete(orderId, { payment: { method: "CASH", amount } } as never, operator(), key),
    );
  const claimMeta = async (orderId: string) => (await claimOf(orderId)).meta as any;

  it.each(["ROUTE", "PICKUP"] as const)(
    "P13 (%s) a $70 order dated 3 days ago with a $30 deposit yesterday, $40 CASH at the counter: tender [40], paid 70, balance 0",
    async (path) => {
      const { orderId, invoiceId } = await seed("CONFIRMED", path, { total: 70 });
      await raw.order.update({ where: { id: orderId }, data: { orderDate: daysAgo(3) } });
      await raw.invoicePayment.create({
        data: { invoiceId, amount: 30, method: "CASH", tenantId, createdAt: daysAgo(1) },
      });
      recordForReal();
      const r: any = await completeWith(orderId, 40, `key-${run}-p13-${path}`);
      expect(await amountsOf(invoiceId, true)).toEqual([40]);
      expect(await amountsOf(invoiceId)).toEqual([30, 40]);
      expect(r).toMatchObject({ paid: 70, balanceDue: 0, paymentRecorded: true });
    },
    60_000,
  );

  it("P13.reopen a backdated order: $50 cash, reopened, +$20, re-completed with $20: the 2nd tender IS recorded and a 2nd email goes", async () => {
    const { orderId, invoiceId } = await seed("CONFIRMED", "ROUTE", { total: 50 });
    await raw.order.update({ where: { id: orderId }, data: { orderDate: daysAgo(3) } });
    recordForReal();
    await completeWith(orderId, 50, `key-${run}-p13r-a`);
    expect(emailsFor(orderId)).toBe(1);
    // the reopen and the +$20 edit, as their rows leave them (DELIVERED undone, deliveredAt cleared, the invoice restated)
    await raw.order.update({
      where: { id: orderId },
      data: { status: "CONFIRMED", deliveredAt: null, subtotal: "70", total: "70" },
    });
    await raw.invoice.update({
      where: { id: invoiceId },
      data: { subtotal: 70, total: 70, status: "SENT" },
    });
    await completeWith(orderId, 20, `key-${run}-p13r-b`);
    expect(await amountsOf(invoiceId, true)).toEqual([50, 20]);
    expect(emailsFor(orderId)).toBe(2);
  }, 60_000);

  it("P13.key a different key while DELIVERED changes nothing: completionAt kept, no second tender, no second email", async () => {
    const { orderId, invoiceId } = await seed("CONFIRMED", "ROUTE", { total: 50 });
    recordForReal();
    await completeWith(orderId, 50, `key-${run}-p13k-a`);
    const stamp = (await claimMeta(orderId)).completionAt;
    expect(typeof stamp).toBe("string");
    await completeWith(orderId, 50, `key-${run}-p13k-b`).catch((e) => e);
    expect((await claimMeta(orderId)).completionAt).toBe(stamp);
    expect(await amountsOf(invoiceId, true)).toEqual([50]);
    expect(emailsFor(orderId)).toBe(1);
  }, 60_000);

  it("P13.legacy a DELIVERED claim with no completionAt: a same-key replay records nothing more", async () => {
    const { orderId, invoiceId } = await seed("CONFIRMED", "ROUTE", { total: 50 });
    recordForReal();
    const key = `key-${run}-p13l`;
    await completeWith(orderId, 50, key);
    const claim = await claimOf(orderId);
    const { completionAt: _drop, ...legacy } = claim.meta as any;
    await raw.auditLog.update({ where: { id: claim.id }, data: { meta: legacy } });
    recordPayment.mockClear();
    await completeWith(orderId, 50, key);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(await amountsOf(invoiceId, true)).toEqual([50]);
  }, 60_000);

  // ── SA-913 R8 / R9 (owner 7a): judged before the claim; the confirmed take-off is one locked tx (Orders → stop → run) ──
  let runSeq = 0;
  /** A SCHEDULED run of this tenant with one stop for the shared customer, driven by "Sam"; the orders linked to it. */
  async function onDriverRun(orderIds: string[], stopStatus = "PENDING") {
    runSeq += 1;
    const driverUser = await raw.user.create({
      data: {
        email: `d-${run}-${runSeq}@example.test`,
        username: `d-${run}-${runSeq}`,
        role: "DRIVER",
        tenantId,
      },
    });
    const driver = await raw.driver.create({
      data: { userId: driverUser.id, contactName: "Sam", tenantId },
    });
    const route = await raw.route.create({ data: { name: `R8 ${run}-${runSeq}`, tenantId } });
    const routeStop = await raw.routeStop.create({
      data: { routeId: route.id, stopNumber: 1, customerId, tenantId },
    });
    const routeRun = await raw.routeRun.create({
      data: { routeId: route.id, scheduledDate: new Date(), driverId: driver.id, tenantId },
    });
    const stop = await raw.routeRunStop.create({
      data: {
        routeRunId: routeRun.id,
        routeStopId: routeStop.id,
        stopNumber: 1,
        customerId,
        tenantId,
        status: stopStatus as never,
      },
    });
    await raw.order.updateMany({
      where: { id: { in: orderIds } },
      data: { routeRunId: routeRun.id, routeRunStopId: stop.id },
    });
    return { runId: routeRun.id, stopId: stop.id };
  }
  const claimCount = (orderId: string) =>
    raw.auditLog.count({
      where: { tenantId, entityId: orderId, action: "PICKUP_COMPLETE_CLAIM" },
    });
  const takeOffRows = (orderId: string) =>
    raw.auditLog.findMany({
      where: { tenantId, entityId: orderId, action: AUDIT_ACTIONS.COUNTER_COMPLETE_TAKEN_OFF_RUN },
    });
  const linkOf = async (orderId: string) => {
    const o = await raw.order.findUniqueOrThrow({ where: { id: orderId } });
    return {
      path: o.fulfillPath,
      status: o.status,
      routeRunId: o.routeRunId,
      routeRunStopId: o.routeRunStopId,
    };
  };
  const stopOf = (stopId: string) => raw.routeRunStop.findUniqueOrThrow({ where: { id: stopId } });
  async function expectUntouched(orderId: string, invoiceId: string, want: object) {
    expect(await linkOf(orderId)).toEqual(want);
    expect((await raw.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      "DRAFT",
    );
    expect(sent).toEqual([]);
    expect(email).not.toHaveBeenCalled();
  }
  const withFlag = (orderId: string, key: string, takeOffRun?: boolean) =>
    as(() =>
      engine().complete(
        orderId,
        (takeOffRun === undefined ? {} : { takeOffRun }) as never,
        operator(),
        key,
      ),
    );
  const delivered = { path: "PICKUP", status: "DELIVERED", routeRunId: null, routeRunStopId: null };

  it("R8a a PENDING stop, no confirm: 409 COUNTER_COMPLETE_ON_RUN {driverName, runId} before the claim; the confirm under the SAME key takes it off, the emptied stop SKIPPED", async () => {
    const { orderId, invoiceId } = await seed("CONFIRMED", "ROUTE");
    const { runId, stopId } = await onDriverRun([orderId]);
    const key = `key-${run}-r8a`;
    const err: any = await withFlag(orderId, key).catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: "COUNTER_COMPLETE_ON_RUN",
      driverName: "Sam",
      runId,
    });
    await expectUntouched(orderId, invoiceId, {
      path: "ROUTE",
      status: "CONFIRMED",
      routeRunId: runId,
      routeRunStopId: stopId,
    });
    expect(await claimCount(orderId)).toBe(0); // judged before the claim
    await withFlag(orderId, key, true); // takeOffRun is not in the claim's body hash
    await new Promise((r) => setImmediate(r));
    expect(await linkOf(orderId)).toEqual(delivered);
    const stop = await stopOf(stopId);
    expect({ status: stop.status, skipReason: stop.skipReason }).toEqual({
      status: "SKIPPED",
      skipReason: "Completed at counter",
    });
    expect((await raw.routeRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "SCHEDULED",
    );
    const rows = await takeOffRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ runId, stopId, stopSkipped: true });
    expect(routeProgress).toHaveBeenCalledWith(tenantId, [customerId], { runId }); // the office skip's update
    expect(sent).toEqual([`${invoiceId}:quiet`]);
    expect(pushes).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(email).toHaveBeenCalledTimes(1); // the ONE completion email, nothing about the run
  }, 60_000);

  it("R8b an OUT_FOR_DELIVERY order on the run: taken off with NO demotion (no CONFIRMED write, no delivery-gate pre-judge), DELIVERED alreadyOut", async () => {
    const { orderId } = await seed("OUT_FOR_DELIVERY", "ROUTE");
    await onDriverRun([orderId]);
    const change = jest.spyOn(orders, "changeStatus");
    const gate = jest.spyOn(orders, "assertDeliveryCreditGate");
    try {
      await withFlag(orderId, `key-${run}-r8b`, true);
      expect(await linkOf(orderId)).toEqual(delivered);
      expect(change.mock.calls.map((c: any[]) => c[1]?.status)).toEqual(["DELIVERED"]);
      expect(gate).not.toHaveBeenCalled();
    } finally {
      change.mockRestore();
      gate.mockRestore();
    }
  }, 60_000);

  // W-774 (SA-922 amendment): the #3455 restriction is pre-judged READ-ONLY before the claim, like the credit gate, so its
  // refusal writes nothing. Head: the take-off committed first, then the switch refused, leaving the order off its run.
  it("R8+D7 a restricted store-state line on an on-run order: 409 SELLING_RESTRICTED, still linked to the run, stop untouched, no claim", async () => {
    const { orderId, invoiceId } = await seed("CONFIRMED", "ROUTE");
    const { runId, stopId } = await onDriverRun([orderId]);
    restricted = true;
    const err: any = await withFlag(orderId, `key-${run}-r8d7`, true).catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "SELLING_RESTRICTED" });
    await expectUntouched(orderId, invoiceId, {
      path: "ROUTE",
      status: "CONFIRMED",
      routeRunId: runId,
      routeRunStopId: stopId,
    });
    expect((await stopOf(stopId)).status).toBe("PENDING");
    expect(await takeOffRows(orderId)).toHaveLength(0);
    expect(await claimCount(orderId)).toBe(0);
  }, 60_000);

  // W-773: the staff override travels with Complete at counter: the dto's acknowledgement reaches the switch's judgement
  // (and the pre-judge), so an acknowledged restricted line completes. Head: the dto had no ack, so it was refused.
  it("W-773 an acknowledged override on the request reaches the restriction judgement: the order completes", async () => {
    const { orderId } = await seed("CONFIRMED", "ROUTE");
    restricted = true;
    const ack = {
      restrictionOverrides: [{ lineKey: "n:0", reason: "Store manager approved" }],
      warningHash: "h-w773",
    };
    await as(() => engine().complete(orderId, ack as never, operator(), `key-${run}-w773`));
    expect(lastAck).toMatchObject(ack);
    expect(await linkOf(orderId)).toEqual(delivered);
  }, 60_000);

  it.each(["IN_PROGRESS", "COMPLETED"])(
    "R8c the driver has started the stop (%s): 409 COUNTER_COMPLETE_STOP_STARTED with or without the confirm, nothing written",
    async (stopStatus) => {
      const { orderId, invoiceId } = await seed("CONFIRMED", "ROUTE");
      const { runId, stopId } = await onDriverRun([orderId], stopStatus);
      await raw.routeRun.update({ where: { id: runId }, data: { status: "IN_PROGRESS" } });
      for (const takeOffRun of [undefined, true]) {
        const err: any = await withFlag(orderId, `key-${run}-r8c-${stopStatus}`, takeOffRun).catch(
          (e) => e,
        );
        expect(err?.getStatus?.()).toBe(409);
        expect(err.getResponse()).toMatchObject({
          code: "COUNTER_COMPLETE_STOP_STARTED",
          message: "The driver has started this stop. Finish it on the route.",
        });
      }
      await expectUntouched(orderId, invoiceId, {
        path: "ROUTE",
        status: "CONFIRMED",
        routeRunId: runId,
        routeRunStopId: stopId,
      });
      expect(await claimCount(orderId)).toBe(0);
    },
    60_000,
  );

  it("R8d the driver starts the stop after the pre-judge: the take-off's stop lock refuses COUNTER_COMPLETE_STOP_STARTED, path / status / link unchanged", async () => {
    const { orderId, invoiceId } = await seed("CONFIRMED", "ROUTE");
    const { runId, stopId } = await onDriverRun([orderId]);
    // the credit pre-judge runs after the run pre-judge and before the take-off: the driver starts the stop there
    const gate = jest.spyOn(orders, "assertDeliveryCreditGate").mockImplementationOnce(async () => {
      await raw.routeRunStop.update({ where: { id: stopId }, data: { status: "IN_PROGRESS" } });
    });
    try {
      const err: any = await withFlag(orderId, `key-${run}-r8d`, true).catch((e) => e);
      expect(err?.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: "COUNTER_COMPLETE_STOP_STARTED" });
    } finally {
      gate.mockRestore();
    }
    await expectUntouched(orderId, invoiceId, {
      path: "ROUTE",
      status: "CONFIRMED",
      routeRunId: runId,
      routeRunStopId: stopId,
    });
    expect(await takeOffRows(orderId)).toHaveLength(0);
  }, 60_000);

  it("R8e a stop holding the customer's OTHER order too: ours is unlinked, the stop stays PENDING with the other order", async () => {
    const { orderId } = await seed("CONFIRMED", "ROUTE");
    const other = await seed("CONFIRMED", "ROUTE");
    const { runId, stopId } = await onDriverRun([orderId, other.orderId]);
    await withFlag(orderId, `key-${run}-r8e`, true);
    expect(await linkOf(orderId)).toEqual(delivered);
    expect(await linkOf(other.orderId)).toEqual({
      path: "ROUTE",
      status: "CONFIRMED",
      routeRunId: runId,
      routeRunStopId: stopId,
    });
    const stop = await stopOf(stopId);
    expect({ status: stop.status, skipReason: stop.skipReason }).toEqual({
      status: "PENDING",
      skipReason: null,
    });
    expect((await takeOffRows(orderId))[0]?.meta).toMatchObject({ stopSkipped: false });
    expect(routeProgress).not.toHaveBeenCalled();
  }, 60_000);

  it("R8f lock order: 20 reps of the take-off vs the driver's IN_PROGRESS on the same stop, 0 deadlocks, never an order unlinked from a started stop", async () => {
    const outcomes = { takenOff: 0, refused: 0 };
    for (let rep = 0; rep < 20; rep++) {
      const { orderId } = await seed("CONFIRMED", "ROUTE");
      const { runId, stopId } = await onDriverRun([orderId]);
      await raw.routeRun.update({ where: { id: runId }, data: { status: "IN_PROGRESS" } });
      let release!: () => void;
      const barrier = new Promise<void>((r) => (release = r));
      const takeOff = barrier.then(() =>
        withFlag(orderId, `key-${run}-r8f-${rep}`, true).then(
          () => "ok" as const,
          (e: any) => e,
        ),
      );
      const driver = barrier.then(() =>
        as(() =>
          claimStopStatusChangeOnLiveRun(prisma, runId, stopId, { status: "IN_PROGRESS" }),
        ).then(
          () => "ok" as const,
          (e: any) => e,
        ),
      );
      release();
      const [mine, theirs] = await Promise.all([takeOff, driver]);
      for (const r of [mine, theirs])
        if (r !== "ok") expect(String(r?.code ?? r?.message ?? r)).not.toMatch(/40P01|deadlock/i);
      expect(theirs).toBe("ok"); // the driver's start never fails over a take-off
      const after = await linkOf(orderId);
      if (mine === "ok") {
        outcomes.takenOff += 1;
        expect(after).toEqual(delivered);
        // the take-off committed before the driver's start: it found the stop PENDING (one audit row, the stop skipped)
        expect((await takeOffRows(orderId))[0]?.meta).toMatchObject({ stopSkipped: true });
      } else {
        outcomes.refused += 1;
        expect(mine.getResponse?.()).toMatchObject({ code: "COUNTER_COMPLETE_STOP_STARTED" });
        expect(after).toEqual({
          path: "ROUTE",
          status: "CONFIRMED",
          routeRunId: runId,
          routeRunStopId: stopId,
        });
        expect(await takeOffRows(orderId)).toHaveLength(0);
      }
    }
    expect(outcomes.takenOff + outcomes.refused).toBe(20);
  }, 180_000);

  it("R8g an office-SKIPPED stop: unlinked, and the stop stays SKIPPED with its own reason", async () => {
    const { orderId } = await seed("CONFIRMED", "ROUTE");
    const { stopId } = await onDriverRun([orderId], "SKIPPED");
    await raw.routeRunStop.update({ where: { id: stopId }, data: { skipReason: "Closed today" } });
    await withFlag(orderId, `key-${run}-r8g`, true);
    expect(await linkOf(orderId)).toEqual(delivered);
    const stop = await stopOf(stopId);
    expect({ status: stop.status, skipReason: stop.skipReason }).toEqual({
      status: "SKIPPED",
      skipReason: "Closed today",
    });
  }, 60_000);

  it("R9 a SHIP order shipped with the carrier (shippedAt): 409 COUNTER_COMPLETE_SHIPPED before the claim, nothing written", async () => {
    const { orderId, invoiceId } = await seed("CONFIRMED", "SHIP");
    await raw.order.update({ where: { id: orderId }, data: { shippedAt: new Date() } });
    const err: any = await withFlag(orderId, `key-${run}-r9`, true).catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: "COUNTER_COMPLETE_SHIPPED",
      message: "This order has shipped with the carrier.",
    });
    await expectUntouched(orderId, invoiceId, {
      path: "SHIP",
      status: "CONFIRMED",
      routeRunId: null,
      routeRunStopId: null,
    });
    expect(await claimCount(orderId)).toBe(0);
  }, 60_000);

  it("R9b a SHIP order OUT_FOR_DELIVERY with no shippedAt: 409 COUNTER_COMPLETE_SHIPPED before the claim, nothing written", async () => {
    const { orderId, invoiceId } = await seed("OUT_FOR_DELIVERY", "SHIP");
    const err: any = await withFlag(orderId, `key-${run}-r9b`).catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_COMPLETE_SHIPPED" });
    await expectUntouched(orderId, invoiceId, {
      path: "SHIP",
      status: "OUT_FOR_DELIVERY",
      routeRunId: null,
      routeRunStopId: null,
    });
    expect(await claimCount(orderId)).toBe(0);
  }, 60_000);
});
