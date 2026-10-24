/**
 * SA-727 (counter refund) - real-Postgres proof of what a mocked unit suite cannot: the refund is a RESOLUTION OF THE
 * RETURN (existing EXTERNAL_REFUND), the store-credit XOR refund CAS under the real locks, the awaited audit row's
 * rollback, the concurrent-refund race, net sales netting and the line headroom guard in BOTH directions.
 *
 * Every case builds a throwaway `qa-refund-<run>-<n>` tenant (approved by `assertTestTenant`): a walk-in customer, ONE
 * sale (order + invoice + a CASH payment of the invoice total) and a REAL InlineReturnsService (same Object.create
 * wiring as inline-returns-capture-concurrency.db.spec.ts). The sale's own order is the carrying order, so a capture of
 * N pieces of the 10-piece, $100.00 line prices to N x $10.00 (no tax).
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Written WITHOUT being run in the authoring environment
 * (no DB lane there): first run must be on the compose Postgres.
 */
import { randomUUID } from "crypto";
import { Client } from "pg";
import { Test } from "@nestjs/testing";
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
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { IdempotencyService } from "../common/idempotency.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import { fetchAccrualNetSales } from "../common/invoiced-sales";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("SA-727 counter refund: a return resolution, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let creditNotes: CreditNotesService;
  let returns: ReturnsService;
  let inline: any;
  const tenantIds: string[] = [];
  let seq = 0;
  let numSeq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const numbering = {
      reserveNext: jest.fn().mockImplementation(async () => `N-REFUND-${RUN}-${++numSeq}`),
    };
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
        { provide: NumberingService, useValue: numbering },
      ],
    }).compile();
    creditNotes = mod.get(CreditNotesService);
    returns = mod.get(ReturnsService);
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    inline = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: anyMethod,
      ledger: mod.get(RegulatedLedgerService),
      creditNotes,
      numbering,
      addonService: { hasAddon: async () => true },
      quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
      idempotency: new IdempotencyService(),
    });
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma
        .$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS refund_audit_fail_${tenantId.replace(/-/g, "")} ON "AuditLog"`,
        )
        .catch(swallow);
      await prisma.orderCreditNote.deleteMany(where).catch(swallow);
      await prisma.returnItem.deleteMany(where).catch(swallow);
      await prisma.return.deleteMany(where).catch(swallow);
      await prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /**
   * A walk-in customer, one DELIVERED sale of 10 pieces at $10.00 = $100.00 and (when `paid`) a payment of $100.00 by
   * `method` (CASH unless a case needs another tender, e.g. CREDIT_NOTE for the store-credit rule).
   */
  async function seed(
    label: string,
    opts: { paid?: boolean; walkIn?: boolean; method?: string } = {},
  ) {
    const { paid = true, walkIn = true, method = "CASH" } = opts;
    seq += 1;
    const slug = assertTestTenant(
      `qa-refund-${RUN}-${seq}-${label}`,
      "inline-returns-refund.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `refund ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `walk-in ${label}`,
        contactName: `walk-in ${label}`,
        tenantId,
        isWalkIn: walkIn,
      } as any,
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `Widget ${slug}`,
        unit: "each",
        pricePerUnit: 10,
        currentStock: 0,
      } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-REFUND-${RUN}-${seq}`,
        subtotal: 100,
        tax: 0,
        total: 100,
        status: "DELIVERED",
      } as any,
    });
    await prisma.orderItem.create({
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
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-REFUND-${RUN}-${seq}`,
        status: paid ? "PAID" : "SENT",
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    });
    const line = await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        productId: product.id,
        description: "Widget",
        qty: 10,
        unitPrice: 10,
        subtotal: 100,
      },
    });
    const payment = paid
      ? await prisma.invoicePayment.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            amount: 100,
            method,
            status: "PAID",
          } as any,
        })
      : null;
    return {
      tenantId,
      userId: user.id,
      customerId: customer.id,
      productId: product.id,
      orderId: order.id,
      invoiceId: invoice.id,
      lineId: line.id,
      paymentId: payment?.id ?? null,
    };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  const staff = (s: Seed, role = "OPERATOR") => ({
    sub: s.userId,
    username: role.toLowerCase(),
    role: role as any,
    status: "ACTIVE" as any,
    forcePasswordChange: false,
    tenantId: s.tenantId,
    tenantSlug: "x",
  });
  // The service under test is `any` here (a prototype-built instance), so the results are `any` too.
  const inTenant = (s: Seed, fn: () => Promise<any>): Promise<any> =>
    tenantCtx.run(s.tenantId, fn) as Promise<any>;
  let keySeq = 0;
  /** Captures `pieces` of the sale's product on the sale's own order (a counter return). `returnKey` pins a replay. */
  const capture = (
    s: Seed,
    pieces: number,
    resolution?: "STORE_CREDIT" | "REFUND",
    returnKey = `refund-${RUN}-${++keySeq}`,
    role = "OPERATOR",
  ) =>
    inTenant(s, () =>
      inline.capture(
        {
          customerId: s.customerId,
          orderId: s.orderId,
          items: [{ productId: s.productId, qty: pieces, boxes: 0, pieces }],
          returnKey,
          ...(resolution ? { resolution } : {}),
        },
        staff(s, role),
      ),
    );
  const refund = (s: Seed, id: string, tender = "CASH", expectedAmount = 40, role = "OPERATOR") =>
    inTenant(s, () => inline.refund(id, { tender, expectedAmount }, staff(s, role)));
  const status = (e: any) => e?.status ?? e?.getStatus?.();
  const codeOf = (e: any) => e?.getResponse?.()?.code;
  const fail = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e) => e,
    );
  const row = (id: string) => prisma.return.findUniqueOrThrow({ where: { id } });
  const stock = async (s: Seed) =>
    Number((await prisma.product.findUniqueOrThrow({ where: { id: s.productId } })).currentStock);
  const auditRows = (s: Seed) =>
    prisma.auditLog.findMany({ where: { tenantId: s.tenantId, action: "inline_return.refund" } });
  const creditNoteCount = (s: Seed) => prisma.creditNote.count({ where: { tenantId: s.tenantId } });
  const netSales = (s: Seed) =>
    fetchAccrualNetSales(prisma as any, s.tenantId, {
      gte: new Date(Date.now() - 86_400_000),
      lte: new Date(Date.now() + 86_400_000),
    });
  const creditItem = (s: Seed, amount: number) =>
    inTenant(s, () =>
      creditNotes.create({
        customerId: s.customerId,
        invoiceId: s.invoiceId,
        amount,
        items: [{ invoiceItemId: s.lineId, amount }],
      } as any),
    );

  /**
   * F8: a DETERMINISTIC race. A raw pg connection takes the Return row lock first; `start()` then launches the competing
   * service calls; the helper polls pg_stat_activity (a recursive walk of pg_blocking_pids from the holder, so a second
   * waiter queued behind the first waiter counts too) until ALL of them are queued behind that lock, and only then
   * releases it. So the calls really do contend for the lock (no timing luck, no call that finished before the other
   * started), and the winner is whoever Postgres wakes first. Returns what the calls settled to.
   */
  async function raceBehindReturnLock(
    returnId: string,
    start: () => Array<Promise<any>>,
  ): Promise<Array<PromiseSettledResult<any>>> {
    const url = requireLocalDatabaseUrl();
    const holder = new Client({ connectionString: url });
    const poller = new Client({ connectionString: url }); // autocommit: a fresh pg_stat_activity snapshot per poll
    await holder.connect();
    await poller.connect();
    let settled: Promise<Array<PromiseSettledResult<any>>> | undefined;
    try {
      await holder.query("BEGIN");
      const locked = await holder.query(`SELECT id FROM "Return" WHERE id = $1 FOR UPDATE`, [
        returnId,
      ]);
      expect(locked.rowCount).toBe(1); // the lock is really held
      const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const calls = start();
      settled = Promise.allSettled(calls);
      let queued = 0;
      for (let i = 0; i < 200 && queued < calls.length; i++) {
        const r = await poller.query(
          `WITH RECURSIVE w(pid) AS (
             SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN w ON w.pid = ANY(pg_blocking_pids(a.pid))
           ) SELECT count(*)::int AS n FROM w`,
          [holderPid],
        );
        queued = Number(r.rows[0].n);
        if (queued < calls.length) await new Promise((res) => setTimeout(res, 50));
      }
      if (queued < calls.length) {
        throw new Error(`only ${queued} of ${calls.length} calls queued behind the Return lock`);
      }
      await holder.query("ROLLBACK"); // wrote nothing: release the lock, both calls proceed
      return await settled;
    } catch (err) {
      await holder.query("ROLLBACK").catch(() => undefined);
      if (settled) await settled; // never leave a call dangling past the test
      throw err;
    } finally {
      await holder.end().catch(() => undefined);
      await poller.end().catch(() => undefined);
    }
  }

  it("1. a REFUND capture restocks and records the return RECEIVED but mints NO credit note; a STORE_CREDIT capture is unchanged", async () => {
    const s = await seed("capture");
    const r = await capture(s, 4, "REFUND");
    expect(r).toMatchObject({ status: "RECEIVED", refundPending: true });
    expect(r.creditNoteId).toBeNull();
    expect(await creditNoteCount(s)).toBe(0);
    expect(await stock(s)).toBe(4);
    // SA-727a: the refund INTENT is stored on the row at capture; a PENDING refund counts nowhere
    const stored = await row(r.id);
    expect(stored.refundMethod).toBe("EXTERNAL_REFUND");
    expect(stored.refundedAt).toBeNull();
    expect(stored.refundAmount).toBeNull();
    expect(stored.holdReason).toBeNull();
    expect((await netSales(s)).net).toBe(100);

    const c = await seed("capture-credit");
    const credited = await capture(c, 4); // omitted resolution = STORE_CREDIT
    expect(credited).toMatchObject({ status: "REFUNDED", refundMethod: "CREDIT_NOTE" });
    expect(credited.creditNoteId).toBeTruthy();
    expect(credited).not.toHaveProperty("refundPending");
    expect(await creditNoteCount(c)).toBe(1);
  }, 60_000);

  it("2. walk-in paid -> CASH refund: REFUNDED/EXTERNAL_REFUND $40.00, invoice still PAID with balance 0, net sales reduced, stock restocked ONCE", async () => {
    const s = await seed("cash");
    const r = await capture(s, 4, "REFUND");
    const before = await netSales(s);
    expect(before.net).toBe(100);
    const out = await refund(s, r.id, "CASH", 40);
    expect(out).toMatchObject({
      status: "REFUNDED",
      refundMethod: "EXTERNAL_REFUND",
      refundTender: "CASH",
    });
    expect(Number(out.refundAmount)).toBe(40);

    const stored = await row(r.id);
    expect(stored.status).toBe("REFUNDED");
    expect(stored.refundMethod).toBe("EXTERNAL_REFUND");
    expect(Number(stored.refundAmount)).toBe(40);
    expect(stored.refundedAt).toBeTruthy();
    expect(stored.creditNoteId).toBeNull();

    // AR untouched: no payment written or reversed, the invoice stays PAID
    const inv = await prisma.invoice.findUniqueOrThrow({
      where: { id: s.invoiceId },
      include: { payments: true },
    });
    expect(inv.status).toBe("PAID");
    expect(inv.payments).toHaveLength(1);
    expect(Number(inv.payments[0].amount)).toBe(100);
    expect(await creditNoteCount(s)).toBe(0);

    // net sales nets it by refundedAt (the existing EXTERNAL_REFUND term)
    expect((await netSales(s)).net).toBe(60);
    // the goods were restocked exactly once (at capture), never again by the refund
    expect(await stock(s)).toBe(4);
    expect(
      await prisma.stockMovement.count({ where: { productId: s.productId, type: "RETURN" } }),
    ).toBe(1);
    // ONE awaited audit row carrying the tender
    const audits = await auditRows(s);
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({
      returnId: r.id,
      invoiceIds: [s.invoiceId],
      amount: 40,
      tender: "CASH",
      actor: s.userId,
    });
  }, 60_000);

  it("3. replay: the same tender and amount returns the stored result with ONE audit row and no second write; another tender or amount is 409 RETURN_ALREADY_RESOLVED", async () => {
    const s = await seed("replay");
    const r = await capture(s, 4, "REFUND");
    const first = await refund(s, r.id, "CARD", 40);
    const again = await refund(s, r.id, "CARD", 40);
    expect(again).toMatchObject({ id: r.id, status: "REFUNDED", refundTender: "CARD" });
    expect(Number(again.refundAmount)).toBe(40);
    expect(new Date(again.refundedAt).getTime()).toBe(new Date(first.refundedAt).getTime());
    expect(await auditRows(s)).toHaveLength(1);
    expect(codeOf(await fail(refund(s, r.id, "CASH", 40)))).toBe("RETURN_ALREADY_RESOLVED");
    expect(codeOf(await fail(refund(s, r.id, "CARD", 30)))).toBe("RETURN_ALREADY_RESOLVED");
    expect(await auditRows(s)).toHaveLength(1);
    // SA-740r: the COLUMN is the tender of record, so a replay trusts it even when the audit meta lost its tender
    await prisma.auditLog.updateMany({
      where: { tenantId: s.tenantId, action: "inline_return.refund" },
      data: { meta: { amount: 40 } },
    });
    await expect(refund(s, r.id, "CARD", 40)).resolves.toMatchObject({ refundTender: "CARD" });
    expect(codeOf(await fail(refund(s, r.id, "CASH", 40)))).toBe("RETURN_ALREADY_RESOLVED");
    // a row the backfill has not reached (column null) with an audit row that has NO tender is a mismatch (409), never a replay
    await prisma.return.update({ where: { id: r.id }, data: { refundTender: null } });
    expect(codeOf(await fail(refund(s, r.id, "CARD", 40)))).toBe("RETURN_ALREADY_RESOLVED");
  }, 60_000);

  it("4. store credit XOR refund, both ways: credited then refund = 409; refunded then a credit replay mints nothing", async () => {
    // credit first (a STORE_CREDIT capture), then a refund
    const a = await seed("xor-a");
    const credited = await capture(a, 4);
    const e = await fail(refund(a, credited.id, "CASH", 40));
    expect(status(e)).toBe(409);
    expect(codeOf(e)).toBe("RETURN_ALREADY_RESOLVED");
    expect(await auditRows(a)).toHaveLength(0);
    expect(await creditNoteCount(a)).toBe(1);

    // SA-727a + F6: the capture's resolution is part of the replay fingerprint. The SAME key with the default (STORE_CREDIT)
    // resolution is refused 409 INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS (never a credit note, never a second Return);
    // the identical REFUND resolution still replays; and the refund still works
    const b = await seed("xor-b");
    const key = `xor-b-${RUN}`;
    const rb = await capture(b, 4, "REFUND", key);
    const mismatch = await fail(capture(b, 4, undefined, key)); // the same key, another resolution
    expect(status(mismatch)).toBe(409);
    expect(codeOf(mismatch)).toBe("INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS");
    expect(await creditNoteCount(b)).toBe(0);
    expect(await prisma.return.count({ where: { tenantId: b.tenantId } })).toBe(1);
    expect((await row(rb.id)).creditNoteId).toBeNull();
    const replayed = await capture(b, 4, "REFUND", key); // the same key, the SAME resolution
    expect(replayed).toMatchObject({ id: rb.id, status: "RECEIVED", refundPending: true });
    expect(await creditNoteCount(b)).toBe(0);
    expect(await stock(b)).toBe(4); // restocked once, by the first capture
    await expect(refund(b, rb.id, "CASH", 40)).resolves.toMatchObject({ status: "REFUNDED" });

    // refund first, then a replay: the identical REFUND resolution answers 200 REFUNDED; the other resolution is the 409.
    // Either way no credit is minted on a refunded return
    const c = await seed("xor-c");
    const keyC = `xor-c-${RUN}`;
    const rc = await capture(c, 4, "REFUND", keyC);
    await refund(c, rc.id, "CHECK", 40);
    const replay = await capture(c, 4, "REFUND", keyC);
    expect(replay.status).toBe("REFUNDED");
    expect(codeOf(await fail(capture(c, 4, undefined, keyC)))).toBe(
      "INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS",
    );
    expect(await creditNoteCount(c)).toBe(0);
    expect((await row(rc.id)).refundMethod).toBe("EXTERNAL_REFUND");
    expect(await auditRows(c)).toHaveLength(1);
  }, 60_000);

  it("5. M3: an unpaid sale is refused 409 REFUND_NEEDS_PAID_INVOICE at the REFUND capture (nothing written) and at the refund (payment voided after capture)", async () => {
    const unpaid = await seed("unpaid", { paid: false });
    const e = await fail(capture(unpaid, 4, "REFUND"));
    expect(status(e)).toBe(409);
    expect(codeOf(e)).toBe("REFUND_NEEDS_PAID_INVOICE");
    expect(await prisma.return.count({ where: { tenantId: unpaid.tenantId } })).toBe(0);
    expect(await stock(unpaid)).toBe(0);

    const s = await seed("void-after");
    const r = await capture(s, 4, "REFUND");
    await prisma.invoicePayment.update({ where: { id: s.paymentId! }, data: { status: "VOID" } });
    const e2 = await fail(refund(s, r.id, "CASH", 40));
    expect(status(e2)).toBe(409);
    expect(codeOf(e2)).toBe("REFUND_NEEDS_PAID_INVOICE");
    expect((await row(r.id)).status).toBe("RECEIVED");
    expect(await auditRows(s)).toHaveLength(0);
  }, 60_000);

  it("6. M2: an expectedAmount that differs from the server's amount is 409 REFUND_AMOUNT_CHANGED (carrying the real amount); nothing is written", async () => {
    const s = await seed("amount");
    const r = await capture(s, 4, "REFUND");
    const e: any = await fail(refund(s, r.id, "CASH", 39.99));
    expect(status(e)).toBe(409);
    expect(e.getResponse()).toMatchObject({ code: "REFUND_AMOUNT_CHANGED", amount: 40 });
    expect((await row(r.id)).status).toBe("RECEIVED");
    expect(await auditRows(s)).toHaveLength(0);
  }, 60_000);

  it("7. M4 (inline), refund THEN credit note: a refunded $40 leaves $60 on the $100 line, so a $70 credit note is refused and $60 is allowed", async () => {
    const s = await seed("m4-refund-then-cn");
    const r = await capture(s, 4, "REFUND");
    await refund(s, r.id, "CASH", 40);
    expect(await fail(creditItem(s, 70))).toBeDefined();
    await expect(creditItem(s, 60)).resolves.toBeDefined();
  }, 60_000);

  it("8. M4 (inline), credit note THEN refund: a $70 credit note leaves $30, so a REFUND capture of 4 pieces ($40) is 409 RETURN_REFUND_OVER_LINE_HEADROOM and 3 pieces ($30) fits", async () => {
    const s = await seed("m4-cn-then-refund");
    await creditItem(s, 70);
    const e = await fail(capture(s, 4, "REFUND"));
    expect(status(e)).toBe(409);
    expect(codeOf(e)).toBe("RETURN_REFUND_OVER_LINE_HEADROOM");
    expect(await prisma.return.count({ where: { tenantId: s.tenantId } })).toBe(0);
    const ok = await capture(s, 3, "REFUND");
    await expect(refund(s, ok.id, "CASH", 30)).resolves.toMatchObject({ status: "REFUNDED" });
  }, 60_000);

  it("9. M4 (standard return), EXTERNAL_REFUND THEN credit note: a STANDARD return of 4 pieces refunded outside RouteFlow counts against the line", async () => {
    const s = await seed("m4-standard");
    const ret = await prisma.return.create({
      data: {
        tenantId: s.tenantId,
        orderId: s.orderId,
        customerId: s.customerId,
        reason: "DAMAGED",
        status: "RECEIVED",
        returnNumber: `RTN-REFUND-${RUN}-${++numSeq}`,
        items: { create: [{ tenantId: s.tenantId, productId: s.productId, qty: 4 }] },
      } as any,
    });
    await inTenant(s, () => returns.processRefund(ret.id, { method: "EXTERNAL_REFUND" } as any));
    expect((await row(ret.id)).refundMethod).toBe("EXTERNAL_REFUND");
    expect(await fail(creditItem(s, 70))).toBeDefined(); // only $60 of the line is left
    await expect(creditItem(s, 60)).resolves.toBeDefined();
  }, 60_000);

  it("10. concurrent refunds (two tenders, one return): exactly one 200 and one 409, ONE audit row, the winner's tender stored", async () => {
    const s = await seed("race");
    const r = await capture(s, 4, "REFUND");
    // F8: both refunds are queued on the held Return lock before it is released, so exactly one wins and one loses
    const outcomes = await raceBehindReturnLock(r.id, () => [
      refund(s, r.id, "CASH", 40),
      refund(s, r.id, "CARD", 40),
    ]);
    const ok = outcomes.filter((o) => o.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const bad = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(status(bad[0].reason)).toBe(409); // never a 500
    expect(codeOf(bad[0].reason)).toBe("RETURN_ALREADY_RESOLVED");
    const audits = await auditRows(s);
    expect(audits).toHaveLength(1);
    expect((audits[0].meta as any).tender).toBe(ok[0].value.refundTender);
    expect(await creditNoteCount(s)).toBe(0);
    // the loser left no trace: one claim, one refundedAt, the goods restocked once
    expect(Number((await row(r.id)).refundAmount)).toBe(40);
    expect(await stock(s)).toBe(4);
  }, 60_000);

  it("11. a refund racing a capture REPLAY on the same return: the identical REFUND replay is a 200; a replay with another resolution is a coded 409; either way the refund wins and the loser leaves no side effect", async () => {
    // (a) the same key, the SAME resolution: both calls succeed (the replay is idempotent whatever state the refund left;
    // its pre-read takes no Return lock, so this pair is a plain concurrent run, not a queued one)
    const a = await seed("race-xor-same");
    const keyA = `race-xor-a-${RUN}`;
    const ra = await capture(a, 4, "REFUND", keyA);
    const same = await Promise.allSettled([
      refund(a, ra.id, "CASH", 40),
      capture(a, 4, "REFUND", keyA),
    ]);
    expect(same.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((same[1] as PromiseFulfilledResult<any>).value.id).toBe(ra.id);
    expect(await creditNoteCount(a)).toBe(0);
    expect(await auditRows(a)).toHaveLength(1);

    // (b) the same key, the OTHER resolution (the default): the replay is the 409 mismatch, the refund still wins
    const s = await seed("race-xor");
    const key = `race-xor-${RUN}`;
    const r = await capture(s, 4, "REFUND", key);
    const outcomes = await Promise.allSettled([
      refund(s, r.id, "CASH", 40),
      capture(s, 4, undefined, key),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1].status).toBe("rejected");
    const loser = (outcomes[1] as PromiseRejectedResult).reason;
    expect(status(loser)).toBe(409);
    expect(codeOf(loser)).toBe("INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS");
    const stored = await row(r.id);
    expect(stored.status).toBe("REFUNDED");
    expect(stored.refundMethod).toBe("EXTERNAL_REFUND");
    // the loser's side effects: no credit note, no second audit row, no second Return, no second restock
    expect(await creditNoteCount(s)).toBe(0);
    expect(await auditRows(s)).toHaveLength(1);
    expect(await prisma.return.count({ where: { tenantId: s.tenantId } })).toBe(1);
    expect(await stock(s)).toBe(4);
    expect(
      await prisma.stockMovement.count({ where: { productId: s.productId, type: "RETURN" } }),
    ).toBe(1);
  }, 60_000);

  it("11b. M6: cancelling a PENDING refund (captured, not yet refunded) works and un-restocks the goods; it never counted in net sales", async () => {
    const s = await seed("cancel-pending");
    const r = await capture(s, 4, "REFUND");
    expect(await stock(s)).toBe(4);
    await inTenant(s, () => inline.cancel(r.id, staff(s)));
    expect((await row(r.id)).status).toBe("CANCELLED");
    expect(await stock(s)).toBe(0);
    expect((await netSales(s)).net).toBe(100);
    // and a cancelled pending refund can no longer be refunded
    expect(codeOf(await fail(refund(s, r.id, "CASH", 40)))).toBe("RETURN_NOT_REFUNDABLE");
  }, 60_000);

  it("12. M6: cancelling a refunded return is 409 RETURN_REFUNDED_CASH: still REFUNDED, stock not taken back", async () => {
    const s = await seed("cancel");
    const r = await capture(s, 4, "REFUND");
    await refund(s, r.id, "CASH", 40);
    const e = await fail(inTenant(s, () => inline.cancel(r.id, staff(s))));
    expect(status(e)).toBe(409);
    expect(codeOf(e)).toBe("RETURN_REFUNDED_CASH");
    expect((await row(r.id)).status).toBe("REFUNDED");
    expect(await stock(s)).toBe(4);
    expect(await prisma.stockMovement.count({ where: { productId: s.productId } })).toBe(1);
  }, 60_000);

  it("13. M5: an audit failure rolls the WHOLE refund back (the return stays RECEIVED, no audit row), and a retry then succeeds", async () => {
    const s = await seed("audit-fail");
    const r = await capture(s, 4, "REFUND");
    const trg = `refund_audit_fail_${s.tenantId.replace(/-/g, "")}`;
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${trg}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit down'; END; $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${trg} BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."tenantId" = '${s.tenantId}' AND NEW.action = 'inline_return.refund') EXECUTE FUNCTION ${trg}()`,
    );
    try {
      expect(await fail(refund(s, r.id, "CASH", 40))).toBeDefined();
      const stored = await row(r.id);
      expect(stored.status).toBe("RECEIVED");
      expect(stored.refundMethod).toBe("EXTERNAL_REFUND"); // still the pending refund captured earlier
      expect(stored.refundedAt).toBeNull();
      expect(stored.refundAmount).toBeNull();
      expect(await auditRows(s)).toHaveLength(0);
      expect((await netSales(s)).net).toBe(100);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trg} ON "AuditLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${trg}()`);
    }
    await expect(refund(s, r.id, "CASH", 40)).resolves.toMatchObject({ status: "REFUNDED" });
  }, 60_000);

  it("14. the refund gate: a DRIVER is refused 403 (refund and REFUND capture), the return stays RECEIVED; a TENANT_ADMIN passes", async () => {
    const s = await seed("gate");
    const r = await capture(s, 4, "REFUND");
    expect(status(await fail(refund(s, r.id, "CASH", 40, "DRIVER")))).toBe(403);
    expect(status(await fail(capture(s, 1, "REFUND", undefined, "DRIVER")))).toBe(403);
    expect((await row(r.id)).status).toBe("RECEIVED");
    await expect(refund(s, r.id, "CASH", 40, "TENANT_ADMIN")).resolves.toMatchObject({
      status: "REFUNDED",
    });
  }, 60_000);

  it("15. the quote carries the additive refund fields for a paid walk-in sale (canRefund true, paidMethods [CASH]) and canRefund false for an unpaid one", async () => {
    const s = await seed("quote");
    const q = await inTenant(s, () =>
      inline.quoteService.quote(
        {
          customerId: s.customerId,
          sourceOrderId: s.orderId,
          items: [{ productId: s.productId, qty: 4, boxes: 0, pieces: 4 }],
        },
        staff(s),
      ),
    );
    expect(q).toMatchObject({
      canRefund: true,
      paidInFull: true,
      paidMethods: ["CASH"],
      customerIsWalkIn: true,
      total: 40,
    });
    const u = await seed("quote-unpaid", { paid: false });
    const qu = await inTenant(u, () =>
      inline.quoteService.quote(
        {
          customerId: u.customerId,
          sourceOrderId: u.orderId,
          items: [{ productId: u.productId, qty: 4, boxes: 0, pieces: 4 }],
        },
        staff(u),
      ),
    );
    expect(qu).toMatchObject({ canRefund: false, paidInFull: false });
  }, 60_000);
  const storeCredit = (s: Seed, id: string, role = "OPERATOR") =>
    inTenant(s, () => inline.storeCreditInstead(id, staff(s, role)));

  it("16. SA-727b: Give store credit instead converts a PENDING refund in one tx: REFUNDED/CREDIT_NOTE, ONE credit note, stock not restocked twice, audit {REFUND_PENDING -> STORE_CREDIT}; the refund then loses", async () => {
    const s = await seed("convert");
    const r = await capture(s, 4, "REFUND");
    const out = await storeCredit(s, r.id);
    expect(out).toMatchObject({ status: "REFUNDED", refundMethod: "CREDIT_NOTE" });
    expect(out.creditNoteId).toBeTruthy();
    expect(Number(out.refundAmount)).toBe(40);
    expect(await creditNoteCount(s)).toBe(1);
    expect(await stock(s)).toBe(4);
    const audit = await prisma.auditLog.findMany({
      where: { tenantId: s.tenantId, action: "inline_return.store_credit_instead" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].meta).toMatchObject({ from: "REFUND_PENDING", to: "STORE_CREDIT", amount: 40 });
    const e = await fail(refund(s, r.id, "CASH", 40));
    expect(status(e)).toBe(409);
    expect(codeOf(e)).toBe("RETURN_ALREADY_RESOLVED");
    expect(await auditRows(s)).toHaveLength(0);
  }, 60_000);

  it("17. SA-727b: store credit on a REFUNDED return is 409 RETURN_ALREADY_RESOLVED and mints nothing", async () => {
    const s = await seed("convert-refunded");
    const r = await capture(s, 4, "REFUND");
    await refund(s, r.id, "CASH", 40);
    const e = await fail(storeCredit(s, r.id));
    expect(status(e)).toBe(409);
    expect(codeOf(e)).toBe("RETURN_ALREADY_RESOLVED");
    expect(await creditNoteCount(s)).toBe(0);
    expect((await row(r.id)).refundMethod).toBe("EXTERNAL_REFUND");
  }, 60_000);

  it("18. SA-727b: a refund and a store-credit conversion racing in parallel: exactly one wins, the other is 409, never both and never a 500", async () => {
    const s = await seed("race-convert");
    const r = await capture(s, 4, "REFUND");
    // F8: both calls are queued on the held Return lock before it is released: exactly one winner, one 409 loser
    const outcomes = await raceBehindReturnLock(r.id, () => [
      refund(s, r.id, "CASH", 40),
      storeCredit(s, r.id),
    ]);
    const ok = outcomes.filter((o) => o.status === "fulfilled");
    const bad = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(status(bad[0].reason)).toBe(409);
    expect(codeOf(bad[0].reason)).toBe("RETURN_ALREADY_RESOLVED");
    const credits = await creditNoteCount(s);
    const audits = (await auditRows(s)).length;
    expect(credits + audits).toBe(1);
    expect((await row(r.id)).refundMethod).toBe(credits === 1 ? "CREDIT_NOTE" : "EXTERNAL_REFUND");
    // the loser left no trace: whichever won, the other's audit row does not exist
    const conversions = await prisma.auditLog.count({
      where: { tenantId: s.tenantId, action: "inline_return.store_credit_instead" },
    });
    expect(conversions).toBe(credits);
    expect(await stock(s)).toBe(4);
  }, 60_000);

  it("19. SA-727b: an audit failure in the conversion rolls back the cleared intent and the mint: the pending refund is intact", async () => {
    const s = await seed("convert-audit-fail");
    const r = await capture(s, 4, "REFUND");
    const trg = `convert_audit_fail_${s.tenantId.replace(/-/g, "")}`;
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${trg}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit down'; END; $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${trg} BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."tenantId" = '${s.tenantId}' AND NEW.action = 'inline_return.store_credit_instead') EXECUTE FUNCTION ${trg}()`,
    );
    try {
      expect(await fail(storeCredit(s, r.id))).toBeDefined();
      const stored = await row(r.id);
      expect(stored.status).toBe("RECEIVED");
      expect(stored.refundMethod).toBe("EXTERNAL_REFUND");
      expect(stored.creditNoteId).toBeNull();
      expect(await creditNoteCount(s)).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trg} ON "AuditLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${trg}()`);
    }
    await expect(refund(s, r.id, "CASH", 40)).resolves.toMatchObject({ status: "REFUNDED" });
  }, 60_000);

  it("20. SA-727b: the 'Pending refunds' list (GET /returns?pendingRefund=true) returns exactly the pending ones, flagged refundPending", async () => {
    const s = await seed("pending-list");
    const pending = await capture(s, 2, "REFUND");
    const done = await capture(s, 2, "REFUND");
    await refund(s, done.id, "CASH", 20);
    const credited = await capture(s, 2); // store credit
    const { data } = await inTenant(s, () =>
      returns.findAll({ kind: "INLINE", pendingRefund: true, limit: 50 }),
    );
    const ids = (data as any[]).map((d) => d.id);
    expect(ids).toEqual([pending.id]);
    expect(ids).not.toContain(done.id);
    expect(ids).not.toContain(credited.id);
    expect((data as any[])[0]).toMatchObject({ refundPending: true, refundedAt: null });
  }, 60_000);

  it("21. F4: store credit is never turned into cash: a sale paid with a CREDIT_NOTE payment is refused 409 REFUND_PAID_WITH_STORE_CREDIT at the REFUND capture, the quote says paidWithStoreCredit, and a payment re-tendered after capture is refused at the refund (the return stays RECEIVED)", async () => {
    const a = await seed("sc-paid", { method: "CREDIT_NOTE" });
    const q = await inTenant(a, () =>
      inline.quoteService.quote(
        {
          customerId: a.customerId,
          sourceOrderId: a.orderId,
          items: [{ productId: a.productId, qty: 4, boxes: 0, pieces: 4 }],
        },
        staff(a),
      ),
    );
    expect(q).toMatchObject({ canRefund: false, paidInFull: true, paidWithStoreCredit: true });
    const e = await fail(capture(a, 4, "REFUND"));
    expect(status(e)).toBe(409);
    expect(codeOf(e)).toBe("REFUND_PAID_WITH_STORE_CREDIT");
    expect(await prisma.return.count({ where: { tenantId: a.tenantId } })).toBe(0);
    expect(await stock(a)).toBe(0);
    // store credit stays available for that sale
    const credited = await capture(a, 4);
    expect(credited).toMatchObject({ status: "REFUNDED", refundMethod: "CREDIT_NOTE" });

    // captured while paid in cash, then the payment is a store-credit one (ADVANCE): the refund endpoint refuses on its own
    const s = await seed("sc-paid-after");
    const r = await capture(s, 4, "REFUND");
    await prisma.invoicePayment.update({
      where: { id: s.paymentId! },
      data: { method: "ADVANCE" },
    });
    const e2 = await fail(refund(s, r.id, "CASH", 40));
    expect(status(e2)).toBe(409);
    expect(codeOf(e2)).toBe("REFUND_PAID_WITH_STORE_CREDIT");
    expect((await row(r.id)).status).toBe("RECEIVED");
    expect(await auditRows(s)).toHaveLength(0);
    // ... and "Give store credit instead" is how it goes back
    await expect(storeCredit(s, r.id)).resolves.toMatchObject({
      status: "REFUNDED",
      refundMethod: "CREDIT_NOTE",
    });
  }, 60_000);

  it("22. F3: Give store credit instead is idempotent: a retry of a converted return is a 200 with the same credit note (ONE credit note, ONE conversion audit row); a return credited at capture or refunded still refuses", async () => {
    const s = await seed("convert-retry");
    const r = await capture(s, 4, "REFUND");
    const first = await storeCredit(s, r.id);
    const again = await storeCredit(s, r.id);
    expect(again).toMatchObject({ id: r.id, status: "REFUNDED", refundMethod: "CREDIT_NOTE" });
    expect(again.creditNoteId).toBe(first.creditNoteId);
    expect(await creditNoteCount(s)).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: s.tenantId, action: "inline_return.store_credit_instead" },
      }),
    ).toBe(1);

    // credited at capture (no conversion audit row): still the 409
    const c = await seed("convert-retry-credited");
    const credited = await capture(c, 4);
    expect(codeOf(await fail(storeCredit(c, credited.id)))).toBe("RETURN_ALREADY_RESOLVED");
    expect(await creditNoteCount(c)).toBe(1);

    // refunded: still the 409
    const f = await seed("convert-retry-refunded");
    const rf = await capture(f, 4, "REFUND");
    await refund(f, rf.id, "CASH", 40);
    expect(codeOf(await fail(storeCredit(f, rf.id)))).toBe("RETURN_ALREADY_RESOLVED");
    expect(await creditNoteCount(f)).toBe(0);
  }, 60_000);
});
