/**
 * B1051 — real-Postgres proof that `applyPriceAdjustment` never writes a total BELOW the invoice's
 * CONFIRMED payments. A lower re-price on a PARTIAL invoice used to recompute straight to PAID while
 * the customer was overpaid: `balanceDue` floors at 0, so nothing anywhere said so. Re-pricing an
 * already-PAID invoice is refused ("issue a credit note instead"); a re-price that would MAKE the
 * invoice overpaid is the same act and is now refused the same way, whole (item writes roll back).
 *
 * Real: PrismaService, InvoicesService (recordPayment writes the payment and its status), the
 * regulated ledger. Stubbed collaborators are the set every invoices DB spec stubs, none of which the
 * adjustment's money depends on.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway
 * `qa-b1051-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
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
import { BadRequestException } from "@nestjs/common";
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("a lower re-price never leaves an invoice overpaid or silently PAID (B1051)", () => {
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
        entitlementAuthorityFromEntitlements, // #2241
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
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /**
   * A SENT $150.00 invoice (one line: 10 x $15.00, no tax) with `paid` of cash recorded through the
   * production `recordPayment` writer, which also derives the status (PARTIAL for a part payment).
   * `opts.second` seeds a second SENT $150.00 invoice for the same customer (bulk scope).
   */
  async function seed(label: string, paid: number, opts: { second?: boolean } = {}) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-b1051-${RUN}-${seq}-${label}`,
      "price-adjustment-overpay-b1051.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `B1051 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const product = await prisma.product.create({
      data: { tenantId, name: `p ${label}`, unit: "each", pricePerUnit: 15 },
    });
    const makeInvoice = async (n: number) => {
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          invoiceNumber: `INV-B1051-${RUN}-${seq}-${n}`,
          status: "SENT",
          subtotal: 150,
          taxAmount: 0,
          total: 150,
        },
      });
      const line = await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          productId: product.id,
          description: `p ${label}`,
          qty: 10,
          unitPrice: 15,
          taxRate: 0,
          subtotal: 150,
        },
      });
      return { invoiceId: invoice.id, lineId: line.id };
    };
    const first = await makeInvoice(1);
    const second = opts.second ? await makeInvoice(2) : null;
    if (paid > 0) {
      await tenantCtx.run(tenantId, () =>
        invoices.recordPayment(first.invoiceId, { amount: paid, method: "CASH" } as any),
      );
    }
    return { tenantId, productId: product.id, ...first, second };
  }

  const reprice = (
    s: { tenantId: string; invoiceId: string; lineId: string },
    newUnitPrice: number,
  ) =>
    tenantCtx.run(s.tenantId, () =>
      invoices.applyPriceAdjustment(s.invoiceId, {
        items: [{ itemId: s.lineId, newUnitPrice }],
        scope: "SINGLE",
      } as any),
    );

  /** Run the adjustment and report how it ended; the persisted rows are read afterwards. */
  const attempt = (p: Promise<unknown>) =>
    p.then(
      () => "applied" as const,
      (e: unknown) => e,
    );

  const read = async (s: { invoiceId: string; lineId: string }) => {
    const inv = await prisma.invoice.findUnique({
      where: { id: s.invoiceId },
      include: { items: true },
    });
    return {
      status: inv!.status,
      total: Number(inv!.total),
      paidAt: inv!.paidAt,
      unitPrice: Number(inv!.items.find((i) => i.id === s.lineId)!.unitPrice),
      notes: inv!.internalNotes,
    };
  };

  it("REG-B1051: a $150 -> $80 re-price of a PARTIAL invoice with $100 paid is refused, not PAID", async () => {
    const s = await seed("overpay", 100);
    expect((await read(s)).status).toBe("PARTIAL"); // the production writer's own state

    const outcome = await attempt(reprice(s, 8)); // 10 x $8 = $80 < $100 already paid

    // Persisted state first, so a red run names the wrong value: today the invoice lands
    // status PAID / total 80 / paidAt set with $20 of the customer's money unaccounted for.
    const after = await read(s);
    expect(after.status).toBe("PARTIAL");
    expect(after.total).toBe(150);
    expect(after.paidAt).toBeNull();
    expect(after.unitPrice).toBe(15); // the line write rolled back with the refusal
    expect(after.notes).toBeNull(); // and so did the audit breadcrumb
    expect(outcome).toBeInstanceOf(BadRequestException);
    expect((outcome as Error).message).toContain("overpaid by $20.00");
  });

  it("pin: a re-price that lands EXACTLY on the paid amount ($100 paid, new total $100) settles PAID", async () => {
    const s = await seed("exact", 100);

    const outcome = await attempt(reprice(s, 10)); // 10 x $10 = $100

    expect(outcome).toBe("applied");
    const after = await read(s);
    expect(after.status).toBe("PAID");
    expect(after.total).toBe(100);
    expect(after.paidAt).toBeInstanceOf(Date);
  });

  it("pin: a lower re-price that stays above the paid amount ($60 paid, new total $80) stays PARTIAL", async () => {
    const s = await seed("above", 60);

    const outcome = await attempt(reprice(s, 8)); // 10 x $8 = $80 > $60

    expect(outcome).toBe("applied");
    const after = await read(s);
    expect(after.status).toBe("PARTIAL");
    expect(after.total).toBe(80);
    expect(after.paidAt).toBeNull();
  });

  it("pin: a re-price of an unpaid invoice is untouched by the guard ($0 paid, new total $80 -> SENT)", async () => {
    const s = await seed("unpaid", 0);

    const outcome = await attempt(reprice(s, 8));

    expect(outcome).toBe("applied");
    const after = await read(s);
    expect(after.status).toBe("SENT");
    expect(after.total).toBe(80);
  });

  it("sibling: the bulk scope refuses the overpaying invoice too and leaves it whole", async () => {
    const s = await seed("bulk", 100, { second: true });
    // The second invoice has no payment: re-pricing it is fine. The first (PARTIAL, $100 paid)
    // would land at $80 and must stay exactly as it was.
    const outcome = await attempt(
      tenantCtx.run(s.tenantId, () =>
        invoices.applyPriceAdjustment(s.invoiceId, {
          items: [{ itemId: s.lineId, newUnitPrice: 8 }],
          scope: "ALL_CUSTOMER_SINCE",
          sinceDate: "2000-01-01",
        } as any),
      ),
    );

    const first = await read(s);
    expect(first.status).toBe("PARTIAL");
    expect(first.total).toBe(150);
    expect(first.unitPrice).toBe(15);
    expect(outcome).toBeInstanceOf(BadRequestException);
  });
});
