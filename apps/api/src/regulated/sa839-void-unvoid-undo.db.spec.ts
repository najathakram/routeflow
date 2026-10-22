/**
 * SA-839 (#1478 / B705, #1479 / B706, B693) DB twins (R2, R4, R5, R12, R14) and the race probe (R15),
 * on a real Postgres: the REAL InvoicesService / ReturnsService / InlineReturnsService /
 * CreditNotesService over a REAL RegulatedLedgerService, every assertion read back from the persisted
 * `RegulatedSalesLedger` rows. The unit twins are ./sa839-void-unvoid-undo.spec.ts.
 *
 * Fixture (ruling §5): one regulated line, SALE 10 / 10 / 100.00 / 20.00 (2026-09); return r1 of 3
 * booked through the real `reverseReturnEntries` (-3 / -3 / -30.00 / -6.00).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`); run through `node scripts/local-db-specs.mjs`
 * (its own throwaway rf_dbspec_* database). SAFETY: one throwaway `qa-sa839-<run>` tenant
 * (`assertTestTenant`); `afterAll` deletes exactly that tenant's rows, in FK order.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { ReturnsService } from "../returns/returns.service";
import { InlineReturnsService } from "../returns/inline-returns.service";
import { InlineReturnsQuoteService } from "../returns/inline-returns-quote.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { AddonService } from "../billing/addon.service";
import { IdempotencyService } from "../common/idempotency.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg");

const RUN = randomUUID().slice(0, 8);

interface LineSum {
  qty: number;
  unitBasisQty: number;
  net: number;
  tax: number;
}
const ZERO: LineSum = { qty: 0, unitBasisQty: 0, net: 0, tax: 0 };
const FULL: LineSum = { qty: 10, unitBasisQty: 10, net: 100, tax: 20 };

describeDb("SA-839: regulated ledger void / unvoid / undo on a real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  let creditNotes: CreditNotesService;
  let returns: ReturnsService;
  let inline: InlineReturnsService;
  let ledger: RegulatedLedgerService;
  let tenantId = "";
  let customerId = "";
  let userId = "";
  let categoryId = "";
  let seq = 0;
  const operator = () => ({ sub: userId, role: "OPERATOR", tenantId }) as any;

  const commission = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    ledger = new RegulatedLedgerService(prisma);

    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
        CreditNotesService,
        ReturnsService,
        InlineReturnsService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RegulatedLedgerService, useValue: ledger },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitInvoiceUpdated: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitLowStock: jest.fn(),
            emitStopCompleted: jest.fn(),
            emitUrgentOrder: jest.fn(),
            emitCreditNoteCreated: jest.fn(),
            emitCreditNoteVoided: jest.fn(),
            emitReturnCreated: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendInvoice: jest.fn(),
            isEmailConfigured: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: MessagingService,
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        { provide: CommissionEngineService, useValue: commission },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
        { provide: InlineReturnsQuoteService, useValue: { priceInlineReturn: jest.fn() } },
        { provide: IdempotencyService, useValue: { acquireLock: jest.fn() } },
      ],
    }).compile();
    invoices = mod.get(InvoicesService);
    creditNotes = mod.get(CreditNotesService);
    returns = mod.get(ReturnsService);
    inline = mod.get(InlineReturnsService);

    const slug = assertTestTenant(`qa-sa839-${RUN}`, "sa839-void-unvoid-undo.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `SA-839 ${slug}` } })).id;
    categoryId = (
      await prisma.trackedCategory.create({ data: { name: "Tobacco", taxType: "NONE", tenantId } })
    ).id;
    userId = (
      await prisma.user.create({
        data: {
          email: `op-${RUN}@example.invalid`,
          username: `op-${RUN}`,
          role: "OPERATOR",
          tenantId,
        },
      })
    ).id;
    const custUser = await prisma.user.create({
      data: {
        email: `cust-${RUN}@example.invalid`,
        username: `cust-${RUN}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: custUser.id, businessName: "Acme Co", contactName: "Acme", tenantId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    const where = { where: { tenantId } };
    await prisma.auditLog.deleteMany(where).catch(swallow);
    await prisma.regulatedLedgerParkedReversal.deleteMany(where).catch(swallow);
    await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
    await prisma.regulatedFiling.deleteMany(where).catch(swallow);
    await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
    await prisma.returnItem.deleteMany({ where: { return: { tenantId } } }).catch(swallow);
    await prisma.return.deleteMany(where).catch(swallow);
    await prisma.creditNoteApplyBlock.deleteMany(where).catch(swallow);
    await prisma.invoicePayment.deleteMany(where).catch(swallow);
    await prisma.orderCreditNote.deleteMany(where).catch(swallow);
    await prisma.creditNoteItem.deleteMany(where).catch(swallow);
    await prisma.creditNote.deleteMany(where).catch(swallow);
    await prisma.paymentCounter.deleteMany({ where: { id: tenantId } }).catch(swallow);
    await prisma.tenantConfig.deleteMany(where).catch(swallow);
    await prisma.invoiceItem.deleteMany(where).catch(swallow);
    await prisma.invoice.deleteMany(where).catch(swallow);
    await prisma.orderItem.deleteMany(where).catch(swallow);
    await prisma.order.deleteMany(where).catch(swallow);
    await prisma.product.deleteMany(where).catch(swallow);
    await prisma.customer.deleteMany(where).catch(swallow);
    await prisma.user.deleteMany(where).catch(swallow);
    await prisma.trackedCategory.deleteMany(where).catch(swallow);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await prisma?.$disconnect();
  }, 120_000);

  const as = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  /** One order + SENT invoice with one regulated line (10 / 100.00 / 20.00) and its 2026-09 SALE. */
  async function seedSale(opts: { orderStatus?: string } = {}) {
    seq += 1;
    const product = await prisma.product.create({
      data: {
        name: `regulated ${seq}`,
        unit: "each",
        pricePerUnit: "10.00",
        trackedCategoryId: categoryId,
        tenantId,
      },
    });
    const order = await prisma.order.create({
      data: {
        customerId,
        status: (opts.orderStatus ?? "DELIVERED") as any,
        subtotal: "100",
        total: "120",
        tenantId,
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        status: "DELIVERED",
        qty: 10,
        invoicedQty: 10,
        unitPrice: "10",
        subtotal: "100",
        categoryTaxAmount: "20",
        trackedCategoryId: categoryId,
        tenantId,
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-SA839-${RUN}-${seq}`,
        customerId,
        orderId: order.id,
        status: "SENT",
        subtotal: "100",
        taxAmount: "0",
        total: "100",
        tenantId,
      },
    });
    const item = await prisma.invoiceItem.create({
      data: {
        invoiceId: invoice.id,
        description: `regulated ${seq}`,
        productId: product.id,
        orderItemId: orderItem.id,
        qty: 10,
        unitPrice: "10",
        subtotal: "100",
        categoryTaxAmount: "20",
        trackedCategoryId: categoryId,
        tenantId,
      },
    });
    await prisma.regulatedSalesLedger.create({
      data: {
        tenantId,
        trackedCategoryId: categoryId,
        entryType: "SALE",
        orderId: order.id,
        orderItemId: orderItem.id,
        invoiceId: invoice.id,
        invoiceItemId: item.id,
        qty: 10,
        unitBasisQty: 10,
        netSales: 100,
        categoryTax: 20,
        soldAt: new Date("2026-09-10T00:00:00Z"),
        periodBucket: "2026-09",
      },
    });
    return {
      productId: product.id,
      orderId: order.id,
      orderItemId: orderItem.id,
      invoiceId: invoice.id,
      itemId: item.id,
    };
  }

  /** A RECEIVED return of 3, booked through the REAL reverseReturnEntries. */
  async function seedReturn(
    s: Awaited<ReturnType<typeof seedSale>>,
    kind: "STANDARD" | "INLINE" = "STANDARD",
  ) {
    const ret = await prisma.return.create({
      data: {
        orderId: s.orderId,
        customerId,
        reason: "EXCESS_ORDER",
        status: "RECEIVED",
        kind,
        tenantId,
        items: {
          create: [
            {
              tenantId,
              productId: s.productId,
              qty: 3,
              restock: false,
              ...(kind === "INLINE" ? { sourceOrderId: s.orderId } : {}),
            },
          ],
        },
      } as any,
    });
    await as(() =>
      ledger.reverseReturnEntries({
        returnId: ret.id,
        orderId: s.orderId,
        returnedByProduct: new Map([[s.productId, 3]]),
        returnedUnit: kind === "INLINE" ? "PIECES" : "LINE_UNIT",
        db: prisma.forTenant(),
      }),
    );
    return ret.id;
  }

  async function lineSum(itemId: string, extra: Record<string, unknown> = {}): Promise<LineSum> {
    const rows = await prisma.regulatedSalesLedger.findMany({
      where: { invoiceItemId: itemId, ...extra },
    });
    const s = (k: string) => rows.reduce((n, r: any) => n + Number(r[k]), 0);
    return {
      qty: Math.round(s("qty") * 1000) / 1000,
      unitBasisQty: Math.round(s("unitBasisQty") * 1000) / 1000,
      net: Math.round(s("netSales") * 100) / 100,
      tax: Math.round(s("categoryTax") * 100) / 100,
    };
  }
  const invoiceStatus = async (id: string) =>
    (await prisma.invoice.findUnique({ where: { id }, select: { status: true } }))?.status;

  it("R2: void -> unvoid -> void -> unvoid steps 0, 10, 0, 10 and ends with 3 SALE + 2 REVERSAL", async () => {
    const s = await seedSale();
    await as(() => invoices.voidInvoice(s.invoiceId));
    expect(await lineSum(s.itemId)).toEqual(ZERO);
    await as(() => invoices.unvoidInvoice(s.invoiceId));
    expect(await lineSum(s.itemId)).toEqual(FULL);
    await as(() => invoices.voidInvoice(s.invoiceId));
    expect(await lineSum(s.itemId)).toEqual(ZERO);
    await as(() => invoices.unvoidInvoice(s.invoiceId));
    expect(await lineSum(s.itemId)).toEqual(FULL);
    expect(await invoiceStatus(s.invoiceId)).toBe("DRAFT");
    const rows = await prisma.regulatedSalesLedger.findMany({ where: { invoiceItemId: s.itemId } });
    expect(rows.filter((r) => r.entryType === "SALE")).toHaveLength(3);
    expect(rows.filter((r) => r.entryType === "REVERSAL")).toHaveLength(2);
  });

  it("R4: return r1 -> void -> cancel r1 (STANDARD): the VOID line ends at 0, r1's row is kept, Σ(r1) = 0", async () => {
    const s = await seedSale();
    const r1 = await seedReturn(s);
    const r1Rows = await prisma.regulatedSalesLedger.findMany({ where: { returnId: r1 } });
    await as(() => invoices.voidInvoice(s.invoiceId));
    await as(() => returns.cancel(r1, operator()));

    expect((await prisma.return.findUnique({ where: { id: r1 } }))?.status).toBe("CANCELLED");
    expect(await invoiceStatus(s.invoiceId)).toBe("VOID");
    expect(await lineSum(s.itemId)).toEqual(ZERO);
    const kept = await prisma.regulatedSalesLedger.findMany({
      where: { id: { in: r1Rows.map((r) => r.id) } },
    });
    expect(kept).toHaveLength(r1Rows.length);
    expect(await lineSum(s.itemId, { returnId: r1 })).toEqual(ZERO);
  });

  it("R5: R4 as an INLINE return (PIECES): the VOID line ends at 0", async () => {
    const s = await seedSale();
    const r1 = await seedReturn(s, "INLINE");
    await as(() => invoices.voidInvoice(s.invoiceId));
    await as(() => inline.cancel(r1, operator()));

    expect((await prisma.return.findUnique({ where: { id: r1 } }))?.status).toBe("CANCELLED");
    expect(await lineSum(s.itemId)).toEqual(ZERO);
    expect(await lineSum(s.itemId, { returnId: r1 })).toEqual(ZERO);
  });

  it("R12 (B693): unvoid when the owning order is CANCELLED is a 409 and writes no row", async () => {
    const s = await seedSale();
    await as(() => invoices.voidInvoice(s.invoiceId));
    await prisma.order.update({ where: { id: s.orderId }, data: { status: "CANCELLED" } });
    const before = await prisma.regulatedSalesLedger.count({ where: { invoiceId: s.invoiceId } });

    await expect(as(() => invoices.unvoidInvoice(s.invoiceId))).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "UNVOID_ORDER_CANCELLED" }),
    });
    expect(await invoiceStatus(s.invoiceId)).toBe("VOID");
    expect(await prisma.regulatedSalesLedger.count({ where: { invoiceId: s.invoiceId } })).toBe(
      before,
    );
    const line = await prisma.orderItem.findUnique({ where: { id: s.orderItemId } });
    expect(Number(line!.invoicedQty)).toBe(0);
  });

  it("R14: a credit-note void AFTER the invoice void (the note capped APPLIED by the void) leaves the line at 0", async () => {
    const s = await seedSale();
    seq += 1;
    // a credit of 3 units (30.00 / 6.00) sourced by the invoice, its reversal booked the real way
    const note = await prisma.creditNote.create({
      data: {
        tenantId,
        creditNoteNumber: `CN-SA839-${RUN}-${seq}`,
        customerId,
        invoiceId: s.invoiceId,
        amount: 30,
        status: "ISSUED",
      },
    });
    await prisma.creditNoteItem.create({
      data: {
        tenantId,
        creditNoteId: note.id,
        invoiceItemId: s.itemId,
        trackedCategoryId: categoryId,
        amount: 30,
        qty: 3,
        categoryTax: 6,
      },
    });
    await as(() =>
      ledger.reverseCreditNoteEntries({ creditNoteId: note.id, db: prisma.forTenant() }),
    );
    // 10.00 of it spent on another (standalone) invoice, so the void caps the note to APPLIED
    seq += 1;
    const other = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-SA839-${RUN}-${seq}`,
        status: "DRAFT",
        subtotal: 40,
        total: 40,
        items: {
          create: [
            { tenantId, description: "goods", qty: 1, unitPrice: 40, taxRate: 0, subtotal: 40 },
          ],
        },
      } as any,
    });
    await as(() => invoices.send(other.id, { allowPreDelivery: true }));
    await as(() => creditNotes.applyToInvoice(note.id, other.id, 10));

    await as(() => invoices.voidInvoice(s.invoiceId));
    const capped = await prisma.creditNote.findUnique({ where: { id: note.id } });
    expect({ status: capped?.status, amount: Number(capped?.amount) }).toEqual({
      status: "APPLIED",
      amount: 10,
    });
    expect(await lineSum(s.itemId)).toEqual(ZERO);

    await as(() => creditNotes.voidWithReversal(note.id, userId));
    expect((await prisma.creditNote.findUnique({ where: { id: note.id } }))?.status).toBe("VOID");
    expect(await lineSum(s.itemId)).toEqual(ZERO);
  });

  // ── R15: the race probe (two real connections; a third holds the lock that orders them) ──
  const url = () => process.env.DATABASE_URL as string;
  const settle = <T>(p: Promise<T>) =>
    p.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );
  /** Waits until at least `n` backends of this database wait on a lock (Prisma's tx budget is 5 s). */
  async function waitForLockWaiters(c: any, n: number): Promise<boolean> {
    for (let i = 0; i < 160; i++) {
      const r = await c.query(
        `SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (r.rows[0].n >= n) return true;
      await new Promise((x) => setTimeout(x, 25));
    }
    return false;
  }

  it("R15 (a): void first, the cancel waiting on the Return lock commits SECOND: the VOID line ends at 0", async () => {
    const s = await seedSale();
    const r1 = await seedReturn(s);
    const holder = new Client({ connectionString: url() });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM "Return" WHERE id = $1 FOR UPDATE`, [r1]);
      const cancel = settle(as(() => returns.cancel(r1, operator())));
      expect(await waitForLockWaiters(holder, 1)).toBe(true); // the cancel waits on the Return
      await as(() => invoices.voidInvoice(s.invoiceId)); // the void commits while the cancel waits
      await holder.query("COMMIT");
      const r = await cancel;
      expect(r.ok).toBe(true);
    } finally {
      await holder.end();
    }
    expect(await invoiceStatus(s.invoiceId)).toBe("VOID");
    expect(await lineSum(s.itemId)).toEqual(ZERO);
  });

  it("R15 (b): the cancel holds the locks first, the void (Serializable) waits behind it and commits SECOND: the VOID line ends at 0", async () => {
    const s = await seedSale();
    const r1 = await seedReturn(s);
    const holder = new Client({ connectionString: url() });
    await holder.connect();
    let cancel: Promise<any> | null = null;
    let voided: Promise<any> | null = null;
    try {
      await holder.query("BEGIN");
      // the Invoice row: a cancel that locks Order -> Invoice stops here holding the Order
      await holder.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [s.invoiceId]);
      cancel = settle(as(() => returns.cancel(r1, operator())));
      const cancelWaits = await waitForLockWaiters(holder, 1);
      voided = settle(as(() => invoices.voidInvoice(s.invoiceId)));
      // the void's snapshot is taken at its first statement, which now waits (on the Order or Invoice)
      expect(await waitForLockWaiters(holder, cancelWaits ? 2 : 1)).toBe(true);
      await holder.query("COMMIT");
      const [rc, rv] = await Promise.all([cancel, voided]);
      expect(rc.ok).toBe(true);
      expect(rv.ok).toBe(true);
    } finally {
      await holder.end();
    }
    expect(await invoiceStatus(s.invoiceId)).toBe("VOID");
    expect((await prisma.return.findUnique({ where: { id: r1 } }))?.status).toBe("CANCELLED");
    expect(await lineSum(s.itemId)).toEqual(ZERO);
  });
});
