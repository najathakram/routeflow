/**
 * SA-737: the STANDARD `processRefund` claim on real Postgres, two real connections per case (the barrier pattern of
 * invoice-send-void-race.db.spec.ts: a raw `pg` client holds a lock, the service starts, and the case waits until Postgres says
 * the service is BLOCKED before the holder commits, so the interleaving is real and never a timing guess).
 *
 * What it pins (house lock order: Return -> Order -> the order's invoices, id-sorted):
 *   T1  a void that holds the Order lock while a refund waits: the refund re-reads under the lock and gets 409
 *       RETURN_REFUND_BASIS_CHANGED, refundedAt stays null. HONEST NOTE: only the two-invoice EXTERNAL_REFUND case is a real
 *       money failure on the base (it claimed a stale figure and committed). The one-invoice cases differ on the base only in
 *       the error answered (REFUND_NEEDS_PAID_INVOICE, or the unlocked store-credit claim then a refused mint): they pin the
 *       code and the wait, not a new money loss.
 *   T2  the claim holds the Order lock while a void waits: after the commit the void's guard answers 409
 *       INVOICE_HAS_CASH_REFUND (the two statements voidInvoice runs first: lockInvoiceRow, assertNoCashRefundOnInvoice).
 *   T3  an order cancel after a cash-refunded STANDARD return: 409 ORDER_HAS_CASH_REFUND, nothing voided.
 *   T4  two concurrent refunds of one return: exactly one REFUNDED, the loser is 409, one credit note for store credit.
 *   T5  no 40P01 against order cancel or creditNotes.create on the same order, in either arrival order.
 *   T6  store credit: the claim commits, then the mint runs; a forced mint failure resets the claim (B68).
 *   T7  a recorded refund writes its awaited audit row in the same transaction.
 *   T8  a lock wait past the bound is a retryable 409 CONCURRENT_UPDATE, nothing written.
 *   T9  a recorded refund of a COUNTER order dated inside a closed window is 409 COUNTER_SALE_DAY_CLOSED (SA-750r3): nothing
 *       claimed, no audit row; a reopened close, and a store-credit refund, are not refused by it.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`), run via `npm run local:test:db`. Every tenant is a throwaway
 * `qa-sa737-<run>-<n>` slug approved by `assertTestTenant`; afterAll deletes exactly the tenants this run created.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { OrderStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { ReturnsService } from "./returns.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { lockInvoiceRow } from "../invoices/invoice-send-guard";
import { assertNoCashRefundOnInvoice } from "../invoices/invoice-cash-refund-guard";
import { cancelOrderInTx } from "../orders/order-cancel-tx";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg");

const RUN = randomUUID().slice(0, 8);

type Outcome = { ok: true; v: any } | { ok: false; e: any };
const settle = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
const codeOf = (o: Outcome): string | null =>
  o.ok ? null : (o.e?.getResponse?.()?.code ?? o.e?.code ?? null);
const statusOf = (o: Outcome): number | null =>
  o.ok ? null : (o.e?.getStatus?.() ?? o.e?.status ?? null);
/** The SQLSTATE behind an error from either side (a raw `pg` error, or Prisma's wrapped adapter error). */
const sqlState = (e: any): string | undefined =>
  e?.meta?.driverAdapterError?.cause?.originalCode ?? e?.cause?.originalCode ?? e?.meta?.code;
const deadlocked = (o: Outcome): boolean =>
  !o.ok && (sqlState(o.e) === "40P01" || /40P01|deadlock detected/i.test(String(o.e?.message)));

describeDb("SA-737 the STANDARD refund claim under the Order lock — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let returns: ReturnsService;
  let creditNotes: CreditNotesService;
  let ctl: any; // a raw connection that only watches pg_stat_activity
  const tenantIds: string[] = [];
  let seq = 0;
  let cnSeq = 0;
  let failMints = 0;

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    ctl = new Client({ connectionString: url });
    await ctl.connect();
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        ReturnsService,
        RegulatedLedgerService,
        CommissionEngineService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: RouteFlowGateway, useValue: anyMethod },
        {
          provide: NumberingService,
          useValue: {
            reserveNext: jest.fn().mockImplementation(async () => {
              if (failMints > 0) {
                failMints -= 1;
                throw new Error("mint down (forced)");
              }
              return `CN-SA737-${RUN}-${++cnSeq}`;
            }),
          },
        },
      ],
    }).compile();
    returns = mod.get(ReturnsService);
    creditNotes = mod.get(CreditNotesService);
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.counterDayClose.deleteMany(where).catch(swallow);
      await prisma.returnItem.deleteMany(where).catch(swallow);
      await prisma.return.deleteMany(where).catch(swallow);
      await prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await ctl?.end().catch(swallow);
    await prisma?.$disconnect();
  }, 120_000);

  // ─── seeding ──────────────────────────────────────────────────────────────

  /**
   * One order of `invoiceCount` invoices, each paid in full in cash ($100 for 10 pieces of its own product), and ONE RECEIVED
   * STANDARD return of 2 pieces of the FIRST product ($20 on the first invoice). Single-invoice orders are the default.
   */
  async function seed(label: string, invoiceCount = 1) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa737-${RUN}-${seq}-${label}`,
      "returns-refund-claim-sa737.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `sa737 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-SA737-${RUN}-${seq}`,
        subtotal: 100 * invoiceCount,
        tax: 0,
        total: 100 * invoiceCount,
        status: "PENDING",
      } as any,
    });
    const productIds: string[] = [];
    const invoiceIds: string[] = [];
    const paymentIds: string[] = [];
    for (let i = 0; i < invoiceCount; i++) {
      // eslint-disable-next-line no-await-in-loop
      const product = await prisma.product.create({
        data: { tenantId, name: `P${i} ${slug}`, unit: "each", pricePerUnit: 10 } as any,
      });
      productIds.push(product.id);
      // eslint-disable-next-line no-await-in-loop
      const orderItem = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          name: product.name,
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
        } as any,
      });
      // eslint-disable-next-line no-await-in-loop
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-SA737-${RUN}-${seq}-${i}`,
          status: "PAID",
          subtotal: 100,
          taxAmount: 0,
          total: 100,
        },
      });
      invoiceIds.push(invoice.id);
      // eslint-disable-next-line no-await-in-loop
      await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          orderItemId: orderItem.id,
          productId: product.id,
          description: `line ${i}`,
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
        } as any,
      });
      // eslint-disable-next-line no-await-in-loop
      const payment = await prisma.invoicePayment.create({
        data: { tenantId, invoiceId: invoice.id, amount: 100, method: "CASH", status: "PAID" },
      });
      paymentIds.push(payment.id);
    }
    const ret = await prisma.return.create({
      data: {
        tenantId,
        orderId: order.id,
        customerId: customer.id,
        reason: "DAMAGED",
        status: "RECEIVED",
        returnNumber: `RTN-SA737-${RUN}-${seq}`,
        items: { create: [{ tenantId, productId: productIds[0], qty: 2 }] },
      } as any,
    });
    return {
      tenantId,
      userId: user.id,
      customerId: customer.id,
      orderId: order.id,
      returnId: ret.id,
      productIds,
      invoiceIds,
      paymentIds,
    };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  const actor = (s: Seed) => ({ sub: s.userId, role: "OPERATOR" }) as any;
  const refund = (s: Seed, method: "CREDIT_NOTE" | "EXTERNAL_REFUND", returnId = s.returnId) =>
    settle(
      tenantCtx.run(s.tenantId, () => returns.processRefund(returnId, { method } as any, actor(s))),
    );
  const asTenant = <T>(s: Seed, fn: () => Promise<T>) => tenantCtx.run(s.tenantId, fn);
  const returnRow = (s: Seed) => prisma.return.findUniqueOrThrow({ where: { id: s.returnId } });

  // ─── the barrier ──────────────────────────────────────────────────────────

  /** Polls until at least `n` other backends are waiting on a lock; false on timeout. */
  async function waitForWaiters(n: number, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const r = await ctl.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
      );
      if (r.rows[0].n >= n) return true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((x) => setTimeout(x, 25));
    }
    return false;
  }

  /** A raw connection inside a transaction; `commit()` ends it. */
  async function holder(setup: (c: any) => Promise<void>) {
    const c = new Client({ connectionString: process.env.DATABASE_URL as string });
    await c.connect();
    await c.query("BEGIN");
    await setup(c);
    return {
      c,
      commit: async () => {
        await c.query("COMMIT");
        await c.end();
      },
      rollback: async () => {
        await c.query("ROLLBACK").catch(() => undefined);
        await c.end().catch(() => undefined);
      },
    };
  }
  const lockOrder = (orderId: string) => (c: any) =>
    c.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [orderId]);
  const lockInvoice = (invoiceId: string) => (c: any) =>
    c.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [invoiceId]);

  // ─── T1: a void that committed while the refund waited ────────────────────

  describe("T1: the void holds the Order lock while the refund waits", () => {
    it.each(["EXTERNAL_REFUND", "CREDIT_NOTE"] as const)(
      "%s: 409 RETURN_REFUND_BASIS_CHANGED, the return stays RECEIVED with refundedAt null",
      async (method) => {
        const s = await seed(`t1-${method.slice(0, 3)}`);
        const h = await holder(async (c) => {
          await lockOrder(s.orderId)(c);
          await lockInvoice(s.invoiceIds[0])(c);
          await c.query(`UPDATE "Invoice" SET status = 'VOID' WHERE id = $1`, [s.invoiceIds[0]]);
        });
        const pending = refund(s, method);
        const blocked = await waitForWaiters(1);
        await h.commit();
        const out = await pending;

        expect(blocked).toBe(true); // the refund WAITED on the void's Order lock (red before: it did not wait)
        expect(statusOf(out)).toBe(409);
        expect(codeOf(out)).toBe("RETURN_REFUND_BASIS_CHANGED");
        const row = await returnRow(s);
        expect([row.status, row.refundedAt, row.refundMethod, row.creditNoteId]).toEqual([
          "RECEIVED",
          null,
          null,
          null,
        ]);
        expect(await prisma.creditNote.count({ where: { tenantId: s.tenantId } })).toBe(0);
        expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId } })).toBe(0);
      },
    );

    it("EXTERNAL_REFUND on a two-invoice order: voiding the only invoice that billed the returned item is 409, not a claim on the first figure", async () => {
      const s = await seed("t1-two", 2); // the return is of product 0, billed on invoice 0 only
      const h = await holder(async (c) => {
        await lockOrder(s.orderId)(c);
        await lockInvoice(s.invoiceIds[0])(c);
        await c.query(`UPDATE "Invoice" SET status = 'VOID' WHERE id = $1`, [s.invoiceIds[0]]);
      });
      const pending = refund(s, "EXTERNAL_REFUND");
      const blocked = await waitForWaiters(1);
      await h.commit();
      const out = await pending;

      expect(blocked).toBe(true);
      expect(codeOf(out)).toBe("RETURN_REFUND_BASIS_CHANGED");
      // red before: invoice 1 (paid in full) satisfied the paid-in-full rule and the stale $20 was claimed
      expect((await returnRow(s)).refundedAt).toBeNull();
    });
  });

  // ─── T2 / T3: the void and the cancel after a claim ───────────────────────

  describe("T2/T3: a void or a cancel behind (or after) the claim sees the cash refund", () => {
    it("T2: the claim holds the Order lock while a void waits; after the commit the void is 409 INVOICE_HAS_CASH_REFUND", async () => {
      const s = await seed("t2");
      // a holder on the INVOICE row parks the claim after it took the Return and Order locks
      const h = await holder(lockInvoice(s.invoiceIds[0]));
      const claim = refund(s, "EXTERNAL_REFUND");
      const claimBlocked = await waitForWaiters(1); // the claim waits on the invoice, holding the Order
      // voidInvoice's first two statements: lock (Order ->) Invoice, then the cash-refund guard
      const voidPrefix = settle(
        asTenant(s, () =>
          prisma.tenantTransaction(async (tx: any) => {
            await lockInvoiceRow(tx, s.invoiceIds[0], s.orderId);
            await assertNoCashRefundOnInvoice(tx, s.invoiceIds[0], s.orderId);
          }),
        ),
      );
      const voidBlocked = await waitForWaiters(2); // ...and the void waits on the claim's Order lock
      await h.commit();
      const [claimOut, voidOut] = await Promise.all([claim, voidPrefix]);

      expect(claimBlocked).toBe(true);
      expect(voidBlocked).toBe(true);
      expect(claimOut.ok).toBe(true);
      expect((await returnRow(s)).refundedAt).not.toBeNull();
      expect(statusOf(voidOut)).toBe(409);
      expect(codeOf(voidOut)).toBe("INVOICE_HAS_CASH_REFUND");
    });

    it("T3: an order cancel on an order with a cash-refunded STANDARD return is 409 ORDER_HAS_CASH_REFUND and voids nothing", async () => {
      const s = await seed("t3");
      expect((await refund(s, "EXTERNAL_REFUND")).ok).toBe(true);
      // the cash payment was reversed afterwards, so the cancel's payment blocker no longer answers first
      await prisma.invoicePayment.updateMany({
        where: { tenantId: s.tenantId },
        data: { status: "VOID" },
      });
      const voided: string[] = [];
      const out = await settle(
        asTenant(s, () =>
          prisma.tenantTransaction((tx: any) =>
            cancelOrderInTx(
              {
                settleStockForEdit: async () => undefined,
                creditNotes: { releaseOrderCreditsInTx: async () => [] } as any,
                invoices: {
                  releaseWalletPaymentsInTx: async () => undefined,
                  voidInvoiceInTx: async (_tx: any, id: string) => {
                    voided.push(id);
                  },
                } as any,
              },
              tx,
              { id: s.orderId },
              {
                fromStatuses: [OrderStatus.PENDING],
                statusUpdateData: { status: OrderStatus.CANCELLED },
                carrier: null,
                user: actor(s),
                notes: "CANCEL",
              },
            ),
          ),
        ),
      );
      expect(statusOf(out)).toBe(409);
      expect(codeOf(out)).toBe("ORDER_HAS_CASH_REFUND");
      expect(voided).toEqual([]);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).status).toBe(
        "PENDING",
      );
    });
  });

  // ─── T4: two refunds of one return ────────────────────────────────────────

  describe("T4: two concurrent refunds of one return", () => {
    it.each(["EXTERNAL_REFUND", "CREDIT_NOTE"] as const)(
      "%s: exactly one REFUNDED, the loser is 409 with today's text",
      async (method) => {
        const s = await seed(`t4-${method.slice(0, 3)}`);
        // both pass the unlocked first read, then park on the Return row lock
        const h = await holder((c) =>
          c.query(`SELECT id FROM "Return" WHERE id = $1 FOR UPDATE`, [s.returnId]),
        );
        const a = refund(s, method);
        const b = refund(s, method);
        const blocked = await waitForWaiters(2);
        await h.commit();
        const outs = await Promise.all([a, b]);

        expect(blocked).toBe(true);
        expect(outs.filter((o) => o.ok)).toHaveLength(1);
        const loser = outs.find((o) => !o.ok) as Extract<Outcome, { ok: false }>;
        expect(statusOf(loser)).toBe(409);
        expect(String(loser.e.message)).toBe("Only RECEIVED returns can be refunded");
        expect((await returnRow(s)).status).toBe("REFUNDED");
        expect(await prisma.creditNote.count({ where: { tenantId: s.tenantId } })).toBe(
          method === "CREDIT_NOTE" ? 1 : 0,
        );
      },
    );
  });

  // ─── T5: no deadlock ──────────────────────────────────────────────────────

  describe("T5: no 40P01 against the other Order -> Invoice writers, in either arrival order", () => {
    const cancelOrder = (s: Seed) =>
      settle(
        asTenant(s, () =>
          prisma.tenantTransaction((tx: any) =>
            cancelOrderInTx(
              {
                settleStockForEdit: async () => undefined,
                creditNotes: { releaseOrderCreditsInTx: async () => [] } as any,
                invoices: {
                  releaseWalletPaymentsInTx: async () => undefined,
                  voidInvoiceInTx: async (t: any, id: string) => {
                    await t.invoice.update({ where: { id }, data: { status: "VOID" } });
                  },
                } as any,
              },
              tx,
              { id: s.orderId },
              {
                fromStatuses: [OrderStatus.PENDING],
                statusUpdateData: { status: OrderStatus.CANCELLED },
                carrier: null,
                user: actor(s),
                notes: "CANCEL",
              },
            ),
          ),
        ),
      );
    const credit = (s: Seed, invoiceIndex = 0) =>
      settle(
        asTenant(s, () =>
          creditNotes.create({
            customerId: s.customerId,
            invoiceId: s.invoiceIds[invoiceIndex],
            amount: 5,
            reason: "sa737 deadlock probe",
          }),
        ),
      );

    it.each([
      ["refund first", true],
      ["cancel first", false],
    ])(
      "store-credit refund vs order cancel on the same order (%s): neither is a deadlock",
      async (_label, refundFirst) => {
        const s = await seed(`t5c-${refundFirst ? "r" : "c"}`);
        const h = await holder(lockOrder(s.orderId));
        const started: Array<Promise<Outcome>> = [];
        started.push(refundFirst ? refund(s, "CREDIT_NOTE") : cancelOrder(s));
        const first = await waitForWaiters(1);
        started.push(refundFirst ? cancelOrder(s) : refund(s, "CREDIT_NOTE"));
        const both = await waitForWaiters(2);
        await h.commit();
        const outs = await Promise.all(started);
        expect({ first, both }).toEqual({ first: true, both: true });
        expect(outs.some(deadlocked)).toBe(false);
      },
    );

    // creditNotes.create takes the ORDER row only when the order has 2+ creditable invoices (lockOrderPoolRows); on a lone
    // invoice it takes the INVOICE row alone. So the barrier is the Order lock for a two-invoice order and the Invoice lock
    // for a one-invoice order: in both shapes the refund and the credit note queue on the same row, and the two money-out
    // writes are on different money (a $20 recorded refund, a $5 credit note), so BOTH must land.
    it.each([
      ["two invoices, Order barrier", 2, true, true],
      ["two invoices, Order barrier", 2, false, true],
      ["one invoice, Invoice barrier", 1, true, false],
      ["one invoice, Invoice barrier", 1, false, false],
    ])(
      "recorded refund vs creditNotes.create (%s, refund first: %s): both land, no 40P01",
      async (_label, invoiceCount, refundFirst, orderBarrier) => {
        const s = await seed(`t5n-${invoiceCount}${refundFirst ? "r" : "n"}`, invoiceCount);
        // the credit note goes on the LAST invoice; the refunded item sits on the first (the same one on a lone invoice)
        const creditIndex = invoiceCount - 1;
        const h = await holder(orderBarrier ? lockOrder(s.orderId) : lockInvoice(s.invoiceIds[0]));
        const started: Array<Promise<Outcome>> = [];
        started.push(refundFirst ? refund(s, "EXTERNAL_REFUND") : credit(s, creditIndex));
        const first = await waitForWaiters(1);
        started.push(refundFirst ? credit(s, creditIndex) : refund(s, "EXTERNAL_REFUND"));
        const both = await waitForWaiters(2);
        await h.commit();
        const outs = await Promise.all(started);
        expect({ first, both }).toEqual({ first: true, both: true });
        expect(outs.some(deadlocked)).toBe(false);
        expect(outs.map((o) => (o.ok ? "ok" : (codeOf(o) ?? String(o.e?.message))))).toEqual([
          "ok",
          "ok",
        ]);
        // the order's money out is exactly what was asked: one recorded refund of 20 and one credit note of 5
        expect((await returnRow(s)).status).toBe("REFUNDED");
        expect(await prisma.creditNote.count({ where: { tenantId: s.tenantId } })).toBe(1);
      },
    );
  });

  // ─── T6: store credit — claim, commit, then mint ──────────────────────────

  describe("T6: store credit mints AFTER the claim has committed", () => {
    it("success: REFUNDED with the credit note linked, one note", async () => {
      const s = await seed("t6-ok");
      const out = await refund(s, "CREDIT_NOTE");
      expect(out.ok).toBe(true);
      const row = await returnRow(s);
      expect(row.status).toBe("REFUNDED");
      expect(row.creditNoteId).not.toBeNull();
      expect(await prisma.creditNote.count({ where: { tenantId: s.tenantId } })).toBe(1);
    });

    it("a mint that fails resets the claim to RECEIVED (B68), and the retry succeeds", async () => {
      const s = await seed("t6-fail");
      failMints = 1;
      const out = await refund(s, "CREDIT_NOTE");
      expect(out.ok).toBe(false);
      expect(String((out as any).e?.message)).toMatch(/mint down/);
      const reset = await returnRow(s);
      expect([
        reset.status,
        reset.refundMethod,
        reset.refundAmount,
        reset.refundedAt,
        reset.creditNoteId,
      ]).toEqual(["RECEIVED", null, null, null, null]);
      expect(await prisma.creditNote.count({ where: { tenantId: s.tenantId } })).toBe(0);

      expect((await refund(s, "CREDIT_NOTE")).ok).toBe(true);
      expect((await returnRow(s)).status).toBe("REFUNDED");
    });
  });

  // ─── T7: the audit row ────────────────────────────────────────────────────

  it("T7: a recorded refund writes ONE audit row with the amount, tender and invoices, in the claim's transaction", async () => {
    const s = await seed("t7");
    const out = await settle(
      tenantCtx.run(s.tenantId, () =>
        returns.processRefund(
          s.returnId,
          { method: "EXTERNAL_REFUND", tender: "CASH" } as any,
          actor(s),
        ),
      ),
    );
    expect(out.ok).toBe(true);
    const rows = await prisma.auditLog.findMany({
      where: { tenantId: s.tenantId, action: AUDIT_ACTIONS.STANDARD_REFUND_RECORDED },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: s.userId, entityType: "Return", entityId: s.returnId });
    expect(rows[0].meta).toMatchObject({
      returnId: s.returnId,
      orderId: s.orderId,
      customerId: s.customerId,
      invoiceIds: s.invoiceIds,
      amount: 20,
      tender: "CASH",
    });
  });

  // ─── T8: a lock wait past the bound ───────────────────────────────────────

  it("T8: a lock held past the bound is 409 CONCURRENT_UPDATE (retryable), nothing written", async () => {
    const s = await seed("t8");
    const h = await holder(lockOrder(s.orderId));
    let out: Outcome;
    try {
      out = await refund(s, "CREDIT_NOTE"); // waits 2 s on the Order lock (the per-wait bound), then gives up
    } finally {
      await h.rollback();
    }
    expect(statusOf(out)).toBe(409);
    expect(codeOf(out)).toBe("CONCURRENT_UPDATE");
    expect((out as any).e.getResponse().retryable).toBe(true);
    const row = await returnRow(s);
    expect([row.status, row.refundedAt]).toEqual(["RECEIVED", null]);
  }, 30_000);

  // ─── T9: a closed day (SA-750r3) inside the claim ─────────────────────────

  describe("T9: a recorded refund of a counter order dated inside a closed day", () => {
    const MIN = 60_000;
    /** The standard seed, with its order put on the default register and a close in force around the database clock. */
    async function seedClosedCounterDay(label: string) {
      const s = await seed(label);
      await prisma.order.update({ where: { id: s.orderId }, data: { counterSale: true } as any });
      const close = await prisma.counterDayClose.create({
        data: {
          tenantId: s.tenantId,
          registerKey: "main",
          day: new Date(),
          zone: "UTC",
          windowStart: new Date(Date.now() - 60 * MIN),
          windowEnd: new Date(Date.now() + 60 * MIN),
          closedAt: new Date(),
          expectedCash: 0,
          countedCash: 0,
          variance: 0,
          denominations: [],
          totals: {},
        },
      });
      return { s, close };
    }
    const recorded = (s: Seed) => refund(s, "EXTERNAL_REFUND");

    it("is 409 COUNTER_SALE_DAY_CLOSED: nothing is claimed and no audit row is written", async () => {
      const { s } = await seedClosedCounterDay("t9-closed");
      const out = await recorded(s);
      expect(statusOf(out)).toBe(409);
      expect(codeOf(out)).toBe("COUNTER_SALE_DAY_CLOSED");
      const row = await returnRow(s);
      expect([row.status, row.refundedAt, row.refundAmount]).toEqual(["RECEIVED", null, null]);
      expect(
        await prisma.auditLog.count({
          where: { tenantId: s.tenantId, action: AUDIT_ACTIONS.STANDARD_REFUND_RECORDED },
        }),
      ).toBe(0);
    });

    it("a reopened close (reopenedAt set) is open again: the same refund is recorded", async () => {
      const { s, close } = await seedClosedCounterDay("t9-reopened");
      await prisma.counterDayClose.update({
        where: { id: close.id },
        data: { reopenedAt: new Date() },
      });
      const out = await recorded(s);
      expect(out.ok).toBe(true);
      expect((await returnRow(s)).status).toBe("REFUNDED");
    });

    it("a store-credit refund of the same return is not a till event: the close does not refuse it", async () => {
      const { s } = await seedClosedCounterDay("t9-credit");
      const out = await refund(s, "CREDIT_NOTE");
      expect(codeOf(out)).not.toBe("COUNTER_SALE_DAY_CLOSED");
      expect(out.ok).toBe(true);
    });
  });
});
