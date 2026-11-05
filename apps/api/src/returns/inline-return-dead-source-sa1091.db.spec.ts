/**
 * SA-1091 piece 3 (row 631) on REAL Postgres: a dead source. A held inline return is approved some time after it was captured;
 * a stuck store-credit row (RECEIVED, no credit note, no hold) is re-issued when its capture key is replayed. If the invoice the
 * goods were sold on was voided or written off in between, nothing is owed for them any more, yet both paths restocked, reversed
 * the ledger and minted store credit for the sale. Both now refuse, under the locks they already hold and before any write,
 * with 409 RETURN_NOTHING_BILLED naming the invoice ("cancel the return" is the way out).
 *
 * Every case is a throwaway `qa-ds631-<run>-<n>` tenant (approved by `assertTestTenant`), one customer, one product, and one or
 * two DELIVERED sales of 4 pieces at $5.00 = $20.00 with a PAID invoice. Run with `npm run local:test:db`.
 *
 *   DS-1  held DRIVER_CAP return, source voided, approve: 409, no restock, no note, the hold untouched
 *   DS-2  stuck row, source voided, replay with its key: 409, no note
 *   DS-3  source written off: refused; the rule is per source (one dead, one live source: refused naming the dead invoice; the
 *         live one alone approves); an unreferenced return is unaffected
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { IdempotencyService } from "../common/idempotency.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const PRICE = 5;
const PIECES = 4;

type Sale = { orderId: string; orderItemId: string; invoiceId: string; invoiceItemId: string };
type World = {
  tenantId: string;
  userId: string;
  customerId: string;
  productId: string;
  sales: Sale[];
};

describeDb("SA-1091 piece 3: a held or stuck return on a dead source — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let inline: any;
  const tenantIds: string[] = [];
  let seq = 0;
  let numSeq = 0;
  let keySeq = 0;

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
      reserveNext: jest.fn().mockImplementation(async () => `N-DS631-${RUN}-${++numSeq}`),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        RegulatedLedgerService,
        CommissionEngineService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: RouteFlowGateway, useValue: anyMethod },
        { provide: NumberingService, useValue: numbering },
      ],
    }).compile();
    const creditNotes = mod.get(CreditNotesService);
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

  /** One customer and product, and `sales` DELIVERED sales of 4 pieces at $5.00 = $20.00, each with its PAID invoice. */
  async function world(label: string, sales = 1): Promise<World> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-ds631-${RUN}-${seq}-${label}`,
      "inline-return-dead-source-sa1091.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `ds631 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `ds631 ${label}`,
        contactName: `ds631 ${label}`,
        tenantId,
      } as any,
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `Widget ${slug}`,
        unit: "each",
        pricePerUnit: PRICE,
        currentStock: 0,
      } as any,
    });
    const out: Sale[] = [];
    for (let i = 0; i < sales; i++) {
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-DS631-${RUN}-${seq}-${i}`,
          subtotal: PRICE * PIECES,
          tax: 0,
          total: PRICE * PIECES,
          status: "DELIVERED",
        } as any,
      });
      const orderItem = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          name: product.name,
          qty: PIECES,
          unitPrice: PRICE,
          subtotal: PRICE * PIECES,
        } as any,
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-DS631-${RUN}-${seq}-${i}`,
          status: "PAID",
          subtotal: PRICE * PIECES,
          taxAmount: 0,
          total: PRICE * PIECES,
        },
      });
      const invoiceItem = await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          orderItemId: orderItem.id,
          productId: product.id,
          description: "Widget",
          qty: PIECES,
          unitPrice: PRICE,
          subtotal: PRICE * PIECES,
        } as any,
      });
      await prisma.invoicePayment.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          amount: PRICE * PIECES,
          method: "CASH",
          status: "PAID",
        } as any,
      });
      out.push({
        orderId: order.id,
        orderItemId: orderItem.id,
        invoiceId: invoice.id,
        invoiceItemId: invoiceItem.id,
      });
    }
    return {
      tenantId,
      userId: user.id,
      customerId: customer.id,
      productId: product.id,
      sales: out,
    };
  }

  const staff = (w: World) => ({
    sub: w.userId,
    username: "operator",
    role: "OPERATOR" as any,
    status: "ACTIVE" as any,
    forcePasswordChange: false,
    tenantId: w.tenantId,
    tenantSlug: "x",
  });
  const inTenant = (w: World, fn: () => Promise<any>): Promise<any> =>
    tenantCtx.run(w.tenantId, fn) as Promise<any>;
  const status = (e: any) => e?.status ?? e?.getStatus?.();
  const body = (e: any) => e?.getResponse?.() ?? {};
  const settle = (p: Promise<unknown>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );

  const setInvoice = (id: string, status: "VOID" | "WRITTEN_OFF") =>
    prisma.invoice.update({ where: { id }, data: { status } });

  /** A held DRIVER_CAP inline return of `pieces` per listed sale (carried by the first sale's order), as capture leaves it. */
  async function heldReturn(w: World, on: Sale[], opts: { unreferenced?: boolean } = {}) {
    const ret = await prisma.return.create({
      data: {
        orderId: w.sales[0].orderId,
        customerId: w.customerId,
        reason: "EXCESS_ORDER",
        status: "RECEIVED",
        kind: "INLINE",
        holdReason: "DRIVER_CAP",
        heldAmount: String(PRICE * PIECES * on.length),
        creditSubtotal: String(PRICE * PIECES * on.length),
        creditTax: "0.00",
        creditCategoryTax: "0.00",
        tenantId: w.tenantId,
        items: {
          create: on.map((s) => ({
            productId: w.productId,
            qty: String(PIECES),
            restock: true,
            tenantId: w.tenantId,
            unitPrice: String(PRICE),
            subtotal: String(PRICE * PIECES),
            taxAmount: "0.00",
            categoryTax: "0.00",
            pieces: PIECES,
            boxes: 0,
            ...(opts.unreferenced
              ? {}
              : {
                  sourceOrderId: s.orderId,
                  sourceOrderItemId: s.orderItemId,
                  sourceInvoiceItemId: s.invoiceItemId,
                }),
          })),
        },
      },
    });
    return ret.id as string;
  }

  const approve = (w: World, id: string) => settle(inTenant(w, () => inline.approve(id, staff(w))));
  const stock = async (w: World) =>
    Number((await prisma.product.findUniqueOrThrow({ where: { id: w.productId } })).currentStock);
  const liveNotes = (w: World) =>
    prisma.creditNote.count({ where: { tenantId: w.tenantId, status: { not: "VOID" } } });

  function refusedDeadSource(r: { ok: boolean; error?: any }, invoiceId: string) {
    expect(r.ok).toBe(false);
    expect(status(r.error)).toBe(409);
    expect(body(r.error).code).toBe(API_ERROR_CODES.RETURN_NOTHING_BILLED);
    expect(body(r.error).invoiceId).toBe(invoiceId);
  }

  it("DS-1: a held return whose source invoice was voided — approve is a 409; no restock, no note, the hold stays", async () => {
    const w = await world("ds1");
    const id = await heldReturn(w, w.sales);
    await setInvoice(w.sales[0].invoiceId, "VOID");
    const out = await approve(w, id);
    refusedDeadSource(out, w.sales[0].invoiceId);
    const row = await prisma.return.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("RECEIVED");
    expect(row.holdReason).toBe("DRIVER_CAP");
    expect(row.creditNoteId).toBeNull();
    expect(await liveNotes(w)).toBe(0);
    expect(await stock(w)).toBe(0);
  }, 60_000);

  it("DS-2: a stuck row whose source invoice was voided — the replay is a 409 and mints no note", async () => {
    const w = await world("ds2");
    const key = `ds631-${RUN}-${++keySeq}`;
    const dto = {
      customerId: w.customerId,
      orderId: w.sales[0].orderId,
      items: [{ productId: w.productId, qty: PIECES, boxes: 0, pieces: PIECES }],
      returnKey: key,
      resolution: "STORE_CREDIT" as const,
    };
    // the first capture mints its credit in its own transaction now; a ROW STUCK by the old two-step capture is that row with
    // the credit undone (its note gone, its link and settle removed), which is what a replay finds in an old database
    const first = await settle(inTenant(w, () => inline.capture(dto, staff(w))));
    expect(first.ok).toBe(true);
    const ret = await prisma.return.findFirstOrThrow({
      where: { tenantId: w.tenantId, returnKey: key },
    });
    await prisma.orderCreditNote.deleteMany({ where: { tenantId: w.tenantId } });
    await prisma.return.update({
      where: { id: ret.id },
      data: { creditNoteId: null, refundMethod: null, status: "RECEIVED" },
    });
    await prisma.creditNoteItem.deleteMany({ where: { tenantId: w.tenantId } });
    await prisma.creditNote.deleteMany({ where: { tenantId: w.tenantId } });
    await prisma.product.update({ where: { id: w.productId }, data: { currentStock: 0 } });
    await setInvoice(w.sales[0].invoiceId, "VOID");

    const replay = await settle(inTenant(w, () => inline.capture(dto, staff(w))));
    refusedDeadSource(replay, w.sales[0].invoiceId);
    expect(await liveNotes(w)).toBe(0);
    const after = await prisma.return.findUniqueOrThrow({ where: { id: ret.id } });
    expect(after.creditNoteId).toBeNull();
  }, 60_000);

  it("DS-3a: a written-off source is refused the same way", async () => {
    const w = await world("ds3a");
    const id = await heldReturn(w, w.sales);
    await setInvoice(w.sales[0].invoiceId, "WRITTEN_OFF");
    refusedDeadSource(await approve(w, id), w.sales[0].invoiceId);
    expect(await liveNotes(w)).toBe(0);
    expect(await stock(w)).toBe(0);
  }, 60_000);

  it("DS-3b: the rule is per source — a return on a dead and a live sale is refused naming the dead invoice; the live sale alone approves", async () => {
    const w = await world("ds3b", 2);
    const [live, dead] = w.sales;
    await setInvoice(dead.invoiceId, "VOID");
    const both = await heldReturn(w, [live, dead]);
    refusedDeadSource(await approve(w, both), dead.invoiceId);
    expect(await liveNotes(w)).toBe(0);
    expect(await stock(w)).toBe(0);

    const onlyLive = await heldReturn(w, [live]);
    const out = await approve(w, onlyLive);
    expect(out.ok).toBe(true);
    expect(await liveNotes(w)).toBe(1);
    expect(await stock(w)).toBe(PIECES);
  }, 60_000);

  it("DS-3c: a return with no source line (unreferenced) is not asked about the source", async () => {
    const w = await world("ds3c");
    await setInvoice(w.sales[0].invoiceId, "VOID");
    const id = await heldReturn(w, w.sales, { unreferenced: true });
    const out = await approve(w, id);
    expect(out.ok).toBe(true);
    expect(await liveNotes(w)).toBe(1);
  }, 60_000);
});
