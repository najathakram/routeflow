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

  /** A walk-in customer, one DELIVERED sale of 10 pieces at $10.00 = $100.00 and (when `paid`) a CASH payment of $100.00. */
  async function seed(label: string, opts: { paid?: boolean; walkIn?: boolean } = {}) {
    const { paid = true, walkIn = true } = opts;
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
            method: "CASH",
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
  const inTenant = <T>(s: Seed, fn: () => Promise<T>) => tenantCtx.run(s.tenantId, fn);
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

  it("1. a REFUND capture restocks and records the return RECEIVED but mints NO credit note; a STORE_CREDIT capture is unchanged", async () => {
    const s = await seed("capture");
    const r = await capture(s, 4, "REFUND");
    expect(r).toMatchObject({ status: "RECEIVED", refundPending: true });
    expect(r.creditNoteId).toBeNull();
    expect(await creditNoteCount(s)).toBe(0);
    expect(await stock(s)).toBe(4);

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

    // a REFUND-captured return resolved by store credit through the capture replay (default resolution), then a refund
    const b = await seed("xor-b");
    const key = `xor-b-${RUN}`;
    const rb = await capture(b, 4, "REFUND", key);
    await capture(b, 4, undefined, key); // the same key, STORE_CREDIT: mints the credit
    expect(await creditNoteCount(b)).toBe(1);
    expect(codeOf(await fail(refund(b, rb.id, "CASH", 40)))).toBe("RETURN_ALREADY_RESOLVED");
    expect(await auditRows(b)).toHaveLength(0);

    // refund first, then the STORE_CREDIT replay: no credit is minted on a refunded return
    const c = await seed("xor-c");
    const keyC = `xor-c-${RUN}`;
    const rc = await capture(c, 4, "REFUND", keyC);
    await refund(c, rc.id, "CHECK", 40);
    const replay = await capture(c, 4, undefined, keyC);
    expect(replay.status).toBe("REFUNDED");
    expect(await creditNoteCount(c)).toBe(0);
    expect((await row(rc.id)).refundMethod).toBe("EXTERNAL_REFUND");
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
    const outcomes = await Promise.allSettled([
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
  }, 60_000);

  it("11. a refund racing a store-credit issue on the same return: exactly one resolution wins", async () => {
    const s = await seed("race-xor");
    const key = `race-xor-${RUN}`;
    const r = await capture(s, 4, "REFUND", key);
    const outcomes = await Promise.allSettled([
      refund(s, r.id, "CASH", 40),
      capture(s, 4, undefined, key),
    ]);
    for (const o of outcomes) {
      if (o.status === "rejected") expect(status(o.reason)).toBeLessThan(500);
    }
    const stored = await row(r.id);
    expect(stored.status).toBe("REFUNDED");
    const credits = await creditNoteCount(s);
    const audits = (await auditRows(s)).length;
    // exactly one of the two resolutions took the return
    expect(credits + audits).toBe(1);
    expect(stored.refundMethod).toBe(credits === 1 ? "CREDIT_NOTE" : "EXTERNAL_REFUND");
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
      expect(stored.refundMethod).toBeNull();
      expect(stored.refundedAt).toBeNull();
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
          items: [{ productId: u.productId, qty: 4, boxes: 0, pieces: 4 }],
        },
        staff(u),
      ),
    );
    expect(qu).toMatchObject({ canRefund: false, paidInFull: false });
  }, 60_000);
});
