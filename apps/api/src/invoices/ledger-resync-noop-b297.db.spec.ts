/**
 * B297 PR4 (SA-734r2 B5, D5, R6) — real-Postgres pins that a regulated-ledger re-sync WRITES ONLY WHAT
 * CHANGED. A post-delivery order edit rebuilds the invoice's lines (`rebuildSiblingDrafts`) and re-syncs the
 * ledger; it used to reverse every held SALE and rewrite a fresh one into TODAY's period bucket even for a
 * note edit (2 rows per regulated line), and re-created every InvoiceItem under a new id. Now an unchanged
 * line keeps its InvoiceItem row (so the ledger's invoiceItemId pointer stays valid) and its SALE rows, a
 * changed line gets exactly one REVERSAL + SALE pair, a second re-sync is idempotent, and a return's
 * reversal keeps standing.
 *
 * Real: PrismaService, InvoicesService, RegulatedLedgerService. Stubbed collaborators are the set every
 * invoices DB spec stubs, none of which the ledger's money depends on.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway
 * `qa-b297r-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("B297 PR4 — a ledger re-sync writes only what changed, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitInvoiceUpdated: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitLowStock: jest.fn(),
            emitStopCompleted: jest.fn(),
            emitUrgentOrder: jest.fn(),
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
        RegulatedLedgerService,
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: MessagingService,
          useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
        },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    invoices = mod.get(InvoicesService);
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.paymentCounter.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.deliveryMutation.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.trackedCategory.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /**
   * A DELIVERED order of two regulated lines (A: 12 x $10 with a $0.60 excise, B: 6 x $10 with $0.30),
   * wholly invoiced by ONE ISSUED (SENT) invoice. The baseline is set by the production writer itself: one
   * re-sync builds the invoice lines from the order lines and books their SALE rows.
   */
  async function seed(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-b297r-${RUN}-${seq}-${label}`,
      "ledger-resync-noop-b297.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `B297 PR4 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const category = await prisma.trackedCategory.create({
      data: { tenantId, name: `cat ${label}`, taxType: "EXCISE_PER_UNIT", rate: 0.05 },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `p ${label}`,
        unit: "each",
        pricePerUnit: 10,
        trackedCategoryId: category.id,
      },
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        status: "DELIVERED",
        subtotal: 180,
        tax: 0,
        total: 180.9,
      },
    });
    const line = (qty: number, tax: number) =>
      prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          qty,
          unitPrice: 10,
          subtotal: qty * 10,
          invoicedQty: qty, // wholly invoiced: the resync's caller-enforced precondition
          trackedCategoryId: category.id,
          categoryTaxAmount: tax,
          categoryTaxType: "EXCISE_PER_UNIT",
          categoryTaxRate: 0.05,
          categoryPriceIncludesTax: false,
        },
      });
    const a = await line(12, 0.6);
    const b = await line(6, 0.3);
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-B297R-${RUN}-${seq}`,
        status: "SENT",
        subtotal: 180,
        taxAmount: 0.9,
        total: 180.9,
      },
    });
    for (const [li, qty, tax] of [
      [a, 12, 0.6],
      [b, 6, 0.3],
    ] as const) {
      await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          orderItemId: li.id,
          productId: product.id,
          description: `p ${label}`,
          qty,
          unitPrice: 10,
          subtotal: qty * 10,
          trackedCategoryId: category.id,
          categoryTaxAmount: tax,
        },
      });
    }
    const s = {
      tenantId,
      orderId: order.id,
      aId: a.id,
      bId: b.id,
      invoiceId: invoice.id,
      productId: product.id,
    };
    await resync(s); // baseline: the production writer builds the lines and books the SALE rows
    return s;
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  const resync = (s: { tenantId: string; orderId: string }) =>
    tenantCtx.run(s.tenantId, () => invoices.resyncOrderInvoicesForEdit(s.orderId));
  const itemIds = async (s: Seeded) =>
    (
      await prisma.invoiceItem.findMany({
        where: { invoiceId: s.invoiceId },
        orderBy: { orderItemId: "asc" },
      })
    ).map((i) => `${i.orderItemId}:${i.id}`);
  const ledger = (s: Seeded) =>
    prisma.regulatedSalesLedger.findMany({
      where: { invoiceId: s.invoiceId },
      orderBy: { createdAt: "asc" },
    });
  /** Σ per order line of the ledger's signed rows: what the filing reports for that line. */
  const netByLine = async (s: Seeded) => {
    const net: Record<string, { qty: number; net: number; tax: number }> = {};
    for (const r of await ledger(s)) {
      const k = r.orderItemId === s.aId ? "A" : "B";
      net[k] ??= { qty: 0, net: 0, tax: 0 };
      net[k].qty += Number(r.qty);
      net[k].net += Number(r.netSales);
      net[k].tax += Number(r.categoryTax);
    }
    for (const v of Object.values(net)) {
      v.qty = Math.round(v.qty * 1000) / 1000;
      v.net = Math.round(v.net * 100) / 100;
      v.tax = Math.round(v.tax * 100) / 100;
    }
    return net;
  };

  it("harness: the baseline re-sync booked one SALE per regulated line and both lines sit on the invoice", async () => {
    const s = await seed("base");
    const rows = await ledger(s);
    expect(rows.filter((r) => r.entryType === "SALE")).toHaveLength(2);
    expect(await netByLine(s)).toEqual({
      A: { qty: 12, net: 120, tax: 0.6 },
      B: { qty: 6, net: 60, tax: 0.3 },
    });
  }, 120_000);

  it("a note-only order edit writes NO ledger rows and keeps every invoice line row", async () => {
    const s = await seed("note");
    const before = { ledger: (await ledger(s)).map((r) => r.id), items: await itemIds(s) };
    await prisma.orderItem.update({ where: { id: s.aId }, data: { notes: "leave at the dock" } });
    await resync(s);
    expect((await ledger(s)).map((r) => r.id)).toEqual(before.ledger); // master: +2 REVERSAL +2 SALE
    expect(await itemIds(s)).toEqual(before.items); // master: every InvoiceItem re-created under a new id
  }, 120_000);

  it("a quantity edit on ONE line books exactly one REVERSAL + SALE pair for that line and leaves the other alone", async () => {
    const s = await seed("qty");
    const beforeRows = await ledger(s);
    const bBefore = beforeRows.filter((r) => r.orderItemId === s.bId).map((r) => r.id);
    const itemsBefore = await itemIds(s);
    await prisma.orderItem.update({
      where: { id: s.aId },
      data: { qty: 10, subtotal: 100, invoicedQty: 10, categoryTaxAmount: 0.5 },
    });
    await resync(s);
    const after = await ledger(s);
    const added = after.filter((r) => !beforeRows.some((b) => b.id === r.id));
    expect(added.map((r) => [r.orderItemId === s.aId ? "A" : "B", r.entryType]).sort()).toEqual([
      ["A", "REVERSAL"],
      ["A", "SALE"],
    ]);
    expect(after.filter((r) => r.orderItemId === s.bId).map((r) => r.id)).toEqual(bBefore);
    expect(await netByLine(s)).toEqual({
      A: { qty: 10, net: 100, tax: 0.5 },
      B: { qty: 6, net: 60, tax: 0.3 },
    });
    const itemsAfter = await itemIds(s);
    expect(itemsAfter.find((i) => i.startsWith(`${s.bId}:`))).toBe(
      itemsBefore.find((i) => i.startsWith(`${s.bId}:`)),
    ); // the untouched line's InvoiceItem row is the same row
  }, 120_000);

  it("a second re-sync of the same state is idempotent", async () => {
    const s = await seed("twice");
    await prisma.orderItem.update({
      where: { id: s.aId },
      data: { qty: 10, subtotal: 100, invoicedQty: 10, categoryTaxAmount: 0.5 },
    });
    await resync(s);
    const once = (await ledger(s)).map((r) => r.id);
    await resync(s);
    expect((await ledger(s)).map((r) => r.id)).toEqual(once);
    expect(await netByLine(s)).toEqual({
      A: { qty: 10, net: 100, tax: 0.5 },
      B: { qty: 6, net: 60, tax: 0.3 },
    });
  }, 120_000);

  it("a prior return's reversal keeps standing through a re-sync, and a note edit still writes nothing", async () => {
    const s = await seed("return");
    const sale = (await ledger(s)).find((r) => r.orderItemId === s.aId && r.entryType === "SALE")!;
    await prisma.regulatedSalesLedger.create({
      data: {
        tenantId: s.tenantId,
        trackedCategoryId: sale.trackedCategoryId,
        entryType: "REVERSAL",
        orderId: s.orderId,
        orderItemId: s.aId,
        invoiceId: s.invoiceId,
        invoiceItemId: sale.invoiceItemId,
        returnId: randomUUID(), // a return-driven reversal (a scalar pointer, no FK)
        qty: -2,
        unitBasisQty: -2,
        netSales: -20,
        categoryTax: -0.1,
        soldAt: new Date(),
        periodBucket: sale.periodBucket,
      },
    });
    const before = (await ledger(s)).map((r) => r.id);
    await prisma.orderItem.update({ where: { id: s.aId }, data: { notes: "after the return" } });
    await resync(s);
    expect((await ledger(s)).map((r) => r.id)).toEqual(before);
    expect((await netByLine(s)).A).toEqual({ qty: 10, net: 100, tax: 0.5 }); // 12 sold - 2 returned
  }, 120_000);
});
