/**
 * F-05 (#2093, owner ruling 2026-09-25): invoice SPLIT is EXEMPT from the sell ban "with a flag":
 * never blocked, the flagged catalog lines surface on the child invoices that carry them, and ONE
 * audit row (naming the order) is written through the plain client, never a caller's transaction.
 * Its own file: invoices.service.spec.ts sits at its size-ratchet ceiling.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
import { Test } from "@nestjs/testing";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { fillSparseCasBasis } from "./testing/sparse-line-fixtures";

describe("InvoicesService — split restricted-lines flag (F-05 #2093)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    fillSparseCasBasis(); // #2645: sparse order fixtures vs the CAS basis pin
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });
    // #2643: the split bumps each order line's invoicedQty through a CAS updateMany; a mock that
    // matches nothing reads as a concurrent edit (409). Same stub as #2632/#2643's specs.
    prisma.orderItem.updateMany.mockResolvedValue({ count: 1 } as any);
    const module = await Test.createTestingModule({
      providers: [
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitInvoiceUpdated: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
          },
        },
        { provide: EmailService, useValue: { sendInvoice: jest.fn() } },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: RegulatedLedgerService,
          useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
        },
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
        { provide: StorageService, useValue: {} },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  const setup = (verdict: any, orderId: string) => {
    jest.spyOn(service as any, "resolveDefaultTerms").mockResolvedValue({ dueDays: 30 });
    jest.spyOn(service as any, "resolveTenantInvoiceDefaults").mockResolvedValue({});
    jest.spyOn(service as any, "generateInvoiceNumber").mockResolvedValue("INV-2026-0099");
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ ...args.data, items: [], payments: [], customer: {} }),
    );
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-tob", invoiceTreatment: "SEPARATE_INVOICE", taxType: "NONE", rate: 0 },
    ]);
    (service as any).sellingRestrictions.checkLinesSellable.mockImplementation(
      verdict instanceof Error ? () => Promise.reject(verdict) : () => Promise.resolve(verdict),
    );
    const line = (id: string, catId: string | null) => ({
      id,
      productId: `p-${id}`,
      qty: 1,
      invoicedQty: 0,
      unitPrice: 10,
      priceType: "STANDARD",
      trackedCategoryId: catId,
      categoryTaxAmount: 0,
      product: { name: id, unitsPerBox: 0, trackedCategoryId: catId },
    });
    prisma.order.findUnique.mockResolvedValue({
      id: orderId,
      customerId: "cust-1",
      orderNumber: "ORD",
      subtotal: 20,
      tax: 0,
      lineItems: [line("std", null), line("tob", "cat-tob")],
    });
  };

  it("BLOCK never blocks the split; only the sibling carrying the line is flagged", async () => {
    setup(
      {
        outcome: "BLOCK",
        reasons: [{ productId: "p-tob", productName: "Cigs", ruleId: "r1", message: "no CA" }],
      },
      "ord-flag",
    );
    const [primary, sibling] = (await service.createInvoiceFromOrder("ord-flag")) as any[];
    expect(primary.restrictedLines).toEqual([]);
    expect(sibling.restrictedLines).toEqual([
      { productId: "p-tob", productName: "Cigs", ruleId: "r1", message: "no CA" },
    ]);
    // "never silently": ONE audit row, naming the order being invoiced.
    const audits = prisma.auditLog.create.mock.calls.filter(
      ([a]: any[]) => a.data.action === "invoice.split.restricted_lines",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0][0].data).toMatchObject({ entityType: "order", entityId: "ord-flag" });
  });

  it("ALLOW leaves every sibling's restrictedLines empty and writes no audit row", async () => {
    setup({ outcome: "ALLOW", reasons: [] }, "ord-allow");
    const result = (await service.createInvoiceFromOrder("ord-allow")) as any[];
    for (const inv of result) expect(inv.restrictedLines).toEqual([]);
    const audits = prisma.auditLog.create.mock.calls.filter(
      ([a]: any[]) => a.data.action === "invoice.split.restricted_lines",
    );
    expect(audits).toHaveLength(0);
  });

  it("inside a caller's transaction the audit row goes through the plain client, never the tx", async () => {
    setup(
      {
        outcome: "BLOCK",
        reasons: [{ productId: "p-tob", productName: "Cigs", ruleId: "r1", message: "no CA" }],
      },
      "ord-tx",
    );
    const tx = { ...prisma, auditLog: { create: jest.fn() } };
    await service.createInvoiceFromOrder("ord-tx", tx);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(
      prisma.auditLog.create.mock.calls.filter(
        ([a]: any[]) => a.data.action === "invoice.split.restricted_lines",
      ),
    ).toHaveLength(1);
  });

  it("a failing restrictions check never blocks or throws — invoices are still created", async () => {
    setup(new Error("db down"), "ord-fail");
    const result = await service.createInvoiceFromOrder("ord-fail");
    expect(result).toHaveLength(2);
  });
});
