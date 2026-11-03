/**
 * SA-962 row 721 / SA-1098 A-5: a partial invoice (`InvoicesService.createPartialFromOrder`) books its
 * regulated lines into the sales ledger in the same transaction, on a real Postgres. The REAL
 * InvoicesService over a REAL RegulatedLedgerService; every assertion is read back from the persisted
 * `RegulatedSalesLedger` rows. Rows RVA-1..5 are SA-962's five; RVA-13 is A-5's (D-52's state).
 *
 * Fixture: one regulated order line of 10 at 10.00 with 20.00 category tax (SA-839's line).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`); run through `node scripts/local-db-specs.mjs`
 * (its own throwaway rf_dbspec_* database). SAFETY: one throwaway `qa-sa962-<run>` tenant
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

const RUN = randomUUID().slice(0, 8);

interface Sum {
  qty: number;
  net: number;
  tax: number;
  rows: number;
}
const NONE: Sum = { qty: 0, net: 0, tax: 0, rows: 0 };

describeDb("SA-962 row 721: the partial invoice books its regulated sale (real Postgres)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  let ledger: RegulatedLedgerService;
  let tenantId = "";
  let customerId = "";
  let userId = "";
  let categoryId = "";
  let seq = 0;

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

    const slug = assertTestTenant(`qa-sa962-${RUN}`, "partial-invoice-ledger.sa962.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `SA-962 ${slug}` } })).id;
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
    await prisma.deliveryMutation.deleteMany(where).catch(swallow);
    await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
    await prisma.creditNoteApplyBlock.deleteMany(where).catch(swallow);
    await prisma.invoicePayment.deleteMany(where).catch(swallow);
    await prisma.orderCreditNote.deleteMany(where).catch(swallow);
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
  const admin = { sub: "u-1", role: "TENANT_ADMIN", tenantId: "t-1" } as never;

  /**
   * One order of `lines` (each a product at 10.00 with `qty`; regulated lines carry 2.00 category tax per unit),
   * nothing invoiced yet. `status` is the order's (DELIVERED unless a test needs a delivery basis).
   */
  async function seedOrder(
    lines: Array<{ qty: number; regulated: boolean }>,
    status: "DELIVERED" | "PARTIALLY_DELIVERED" = "DELIVERED",
  ) {
    seq += 1;
    const subtotal = lines.reduce((n, l) => n + l.qty * 10, 0);
    const order = await prisma.order.create({
      data: {
        customerId,
        status: status as any,
        orderNumber: `SA962-${RUN}-${seq}`,
        subtotal,
        total: subtotal,
        tenantId,
      },
    });
    const made: Array<{ orderItemId: string; productId: string }> = [];
    for (const [i, l] of lines.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const product = await prisma.product.create({
        data: {
          name: `sa962 ${seq}-${i}`,
          unit: "each",
          pricePerUnit: "10.00",
          tenantId,
          ...(l.regulated ? { trackedCategoryId: categoryId } : {}),
        },
      });
      // eslint-disable-next-line no-await-in-loop
      const item = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: status === "DELIVERED" ? "DELIVERED" : ("PENDING" as any),
          qty: l.qty,
          invoicedQty: 0,
          unitPrice: "10",
          subtotal: l.qty * 10,
          tenantId,
          ...(l.regulated
            ? { categoryTaxAmount: String(l.qty * 2), trackedCategoryId: categoryId }
            : {}),
        },
      });
      made.push({ orderItemId: item.id, productId: product.id });
    }
    return { orderId: order.id, made };
  }

  const partial = (orderId: string, items: Array<[string, number]>, send = false) =>
    as(() =>
      invoices.createPartialFromOrder(orderId, {
        items: items.map(([orderItemId, qty]) => ({ orderItemId, qty })),
        ...(send ? { send: true } : {}),
      } as any),
    ) as Promise<any>;

  const sumOf = (rows: any[]): Sum => ({
    qty: Math.round(rows.reduce((n, r) => n + Number(r.qty), 0) * 1000) / 1000,
    net: Math.round(rows.reduce((n, r) => n + Number(r.netSales), 0) * 100) / 100,
    tax: Math.round(rows.reduce((n, r) => n + Number(r.categoryTax), 0) * 100) / 100,
    rows: rows.length,
  });
  /** Net of every ledger row (SALE and REVERSAL) written for one invoice. */
  const byInvoice = async (invoiceId: string): Promise<Sum> =>
    sumOf(await prisma.regulatedSalesLedger.findMany({ where: { invoiceId } }));
  /** The order line's live net across every invoice that ever booked it. */
  const byLine = async (orderItemId: string): Promise<Sum> =>
    sumOf(await prisma.regulatedSalesLedger.findMany({ where: { orderItemId } }));
  const status = async (id: string) =>
    (await prisma.invoice.findUnique({ where: { id }, select: { status: true } }))?.status;

  it("RVA-1: a regulated line of 10, a partial of 6 books SALE rows netting qty 6 (net 60.00, tax 12.00)", async () => {
    const o = await seedOrder([{ qty: 10, regulated: true }]);
    const inv = await partial(o.orderId, [[o.made[0].orderItemId, 6]]);
    expect(await byInvoice(inv.id)).toEqual({ qty: 6, net: 60, tax: 12, rows: 1 });
    expect(
      (await prisma.regulatedSalesLedger.findMany({ where: { invoiceId: inv.id } }))[0],
    ).toMatchObject({
      entryType: "SALE",
      orderId: o.orderId,
      orderItemId: o.made[0].orderItemId,
    });
  });

  it("RVA-2: then void nets 0 and unvoid books the partial's 6, never the line's 10", async () => {
    const o = await seedOrder([{ qty: 10, regulated: true }]);
    const inv = await partial(o.orderId, [[o.made[0].orderItemId, 6]]);
    expect(await byInvoice(inv.id)).toMatchObject({ qty: 6, rows: 1 });
    await as(() => invoices.voidInvoice(inv.id, admin));
    expect(await byInvoice(inv.id)).toMatchObject({ qty: 0, net: 0, tax: 0, rows: 2 }); // SALE + REVERSAL
    await as(() => invoices.unvoidInvoice(inv.id));
    expect(await status(inv.id)).toBe("DRAFT");
    expect(await byInvoice(inv.id)).toMatchObject({ qty: 6, net: 60, tax: 12 });
    expect(await byLine(o.made[0].orderItemId)).toMatchObject({ qty: 6 });
  });

  it("RVA-3: a second partial of the remaining 4 leaves the order's live rows netting 10", async () => {
    const o = await seedOrder([{ qty: 10, regulated: true }]);
    const first = await partial(o.orderId, [[o.made[0].orderItemId, 6]]);
    const second = await partial(o.orderId, [[o.made[0].orderItemId, 4]]);
    expect(await byInvoice(first.id)).toMatchObject({ qty: 6, net: 60, tax: 12 });
    expect(await byInvoice(second.id)).toMatchObject({ qty: 4, net: 40, tax: 8 });
    expect(await byLine(o.made[0].orderItemId)).toMatchObject({ qty: 10, net: 100, tax: 20 });
  });

  it("RVA-4: the 6-partial, then a delivered-basis reconcile: the ledger always equals the invoice's own qty, written once (never 12)", async () => {
    const o = await seedOrder([{ qty: 10, regulated: true }], "PARTIALLY_DELIVERED");
    await prisma.deliveryMutation.create({
      data: {
        orderId: o.orderId,
        orderItemId: o.made[0].orderItemId,
        productId: o.made[0].productId,
        type: "DELIVERED",
        quantityDelivered: 7,
        tenantId,
      } as any,
    });
    const inv = await partial(o.orderId, [[o.made[0].orderItemId, 6]]);
    expect(await byInvoice(inv.id)).toMatchObject({ qty: 6 });
    await as(() => invoices.reconcileOrderDeliveredInvoices(o.orderId));
    const items = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } });
    const billed = items.reduce((n, i) => n + Number(i.qty), 0);
    // whatever the reconcile rebuilt (or left alone), the ledger holds exactly that qty, once
    expect(await byInvoice(inv.id)).toMatchObject({ qty: billed });
    expect(await byLine(o.made[0].orderItemId)).toMatchObject({ qty: billed });
    expect(billed).not.toBe(12);
  });

  it("RVA-5: a partial of a non-regulated line writes no ledger row", async () => {
    const o = await seedOrder([{ qty: 10, regulated: false }]);
    const inv = await partial(o.orderId, [[o.made[0].orderItemId, 6]]);
    expect(await byInvoice(inv.id)).toEqual(NONE);
    expect(await byLine(o.made[0].orderItemId)).toEqual(NONE);
  });

  it("RVA-13: a line left off a split order (billed by no invoice), cut as a partial with send=true, sits on the sent invoice with its ledger net 2", async () => {
    // D-52's state: a standard line, a regulated line of 2 that no invoice carries
    const o = await seedOrder([
      { qty: 1, regulated: false },
      { qty: 2, regulated: true },
    ]);
    const sent = await partial(o.orderId, [[o.made[1].orderItemId, 2]], true);
    const invoiceId = sent.id ?? sent.invoiceId;
    expect(await status(invoiceId)).toBe("SENT");
    const onIt = await prisma.invoiceItem.findMany({ where: { invoiceId } });
    expect(onIt.map((i) => i.orderItemId)).toEqual([o.made[1].orderItemId]);
    expect(await byInvoice(invoiceId)).toMatchObject({ qty: 2, net: 20, tax: 4 });
    expect(await byLine(o.made[1].orderItemId)).toMatchObject({ qty: 2 });
  });
});
