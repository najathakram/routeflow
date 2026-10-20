/**
 * Row 603 (P2): `PATCH /invoices/:id` decided "recalculate the totals" with `dto.discount !== undefined ||
 * dto.shippingFee !== undefined`, so a JSON `null` (which `@IsOptional()` let through the DTO — row 602) started a
 * locked, order-resyncing recompute of the invoice total as if a new header figure had been sent. A null is an
 * ABSENT figure (`intakeMoney` already reads it as "keep the stored value"), so it must reach neither the
 * units_v1 rewrite guard nor the recompute: the same defence in depth as the DTO's `@IsOptionalNotNull()`.
 * Shares the harness shape of invoices.service.update-header-only-b1043.spec.ts (that file sits near its cap).
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { InvoiceStatus } from "@prisma/client";
import { sumInvoiceTotals } from "@routeflow/pricing";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("InvoicesService.update() — row 603: a null discount / shippingFee is absent, never a recalc", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] }); // units_v1 guard reads the parent invoice
    // The tx the service runs in: the same model mocks, plus a per-test raw query (the NULL-tenant line count).
    queryRaw = jest.fn().mockResolvedValue([]);
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, $executeRaw: jest.fn().mockResolvedValue(0), $queryRaw: queryRaw }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        {
          provide: EmailService,
          useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
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
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
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
          useValue: { reserveNext: jest.fn(), reserveNextTx: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  const draft = {
    id: "inv-1",
    orderId: null as string | null,
    tenantId: "test-tenant",
    deliveryBatchId: null,
    customerId: "cust-1",
    invoiceNumber: "INV-2026-0099",
    status: InvoiceStatus.DRAFT,
    subtotal: 100,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 100,
    notes: null,
    terms: null,
    dueDate: null,
    issueDate: new Date(),
  };
  const row = (o: Record<string, unknown> = {}) => ({
    id: "item-1",
    description: "Widget",
    qty: 1,
    unitPrice: 100,
    discount: 0,
    subtotal: 100,
    taxRate: 0,
    categoryTaxAmount: 0,
    ...o,
  });

  /** Stored invoice + its lines, as the locked tx reads them. */
  const arrange = (
    invoice: Record<string, unknown>,
    lines: Record<string, unknown>[],
    opts: { exempt?: boolean; payments?: Record<string, unknown>[] } = {},
  ) => {
    prisma.invoice.findUnique.mockResolvedValue({ ...draft, ...invoice });
    prisma.invoiceItem.findMany.mockResolvedValue(lines);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: !!opts.exempt });
    prisma.invoicePayment.findMany.mockResolvedValue(opts.payments ?? []);
    prisma.invoice.update.mockResolvedValue({ ...draft, ...invoice });
    prisma.order.findFirst.mockResolvedValue({ lineItems: [] }); // units_v1 guard reads the linked order
  };
  const written = () => prisma.invoice.update.mock.calls[0][0].data;

  const nullOf = (v: null) => v as unknown as number;

  describe.each(["discount", "shippingFee"] as const)("a null %s", (field) => {
    it("is header-only: no transaction, no totals written, only the other header fields", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row()]);
      await service.update("inv-1", { [field]: nullOf(null), notes: "just a note" });
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(written()).toEqual({ notes: "just a note" });
    });

    it("does not run the units_v1 rewrite guard (that guards a real discount / shipping rewrite)", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row()]);
      await service.update("inv-1", { [field]: nullOf(null), notes: "just a note" });
      expect(prisma.invoice.findFirst).not.toHaveBeenCalled();
    });

    it("control: a real figure still runs the rewrite guard and recomputes the total", async () => {
      arrange({ subtotal: 100, taxAmount: 0, total: 100 }, [row()]);
      await service.update("inv-1", { [field]: 5 });
      expect(prisma.invoice.findFirst).toHaveBeenCalled();
      expect(written()).toMatchObject({ [field]: 5, total: field === "discount" ? 95 : 105 });
    });
  });
});
