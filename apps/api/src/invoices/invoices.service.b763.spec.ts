/**
 * B763 — unrounded advance writes. Both `excess` computations (recordStandalonePayment's
 * dto.totalAmount − allocatedTotal, recordDeliveryPaymentInTx's leftover `remaining`) could carry
 * raw floating-point residue into an AdvancePayment row instead of clean cents.
 *
 * Split out of invoices.service.spec.ts (not merged into it) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts` — that file is already at its ceiling). Same bootstrap pattern
 * as the main spec file; duplicated deliberately rather than shared, so this file stays
 * self-contained and small.
 */

// Prevent Jest from traversing ESM-only dependencies
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AfterCommit } from "../common/after-commit";

describe("InvoicesService — B763", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const mockGateway = {
    emitInvoiceUpdated: jest.fn(),
    emitOrderCreated: jest.fn(),
    emitOrderStatusChanged: jest.fn(),
    emitLowStock: jest.fn(),
    emitStopCompleted: jest.fn(),
    emitUrgentOrder: jest.fn(),
  };
  const mockEmailService = {
    sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
    isEmailConfigured: jest.fn().mockResolvedValue(true),
  };
  const mockSystemConfig = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const mockMessaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
  };
  const mockStorage = {
    upload: jest.fn().mockResolvedValue("stored"),
    presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };
  const mockNumbering = { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") };

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            syncInvoiceEntries: jest.fn(),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        { provide: CreditNotesService, useValue: mockCreditNotes },
        { provide: MessagingService, useValue: mockMessaging },
        { provide: StorageService, useValue: mockStorage },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        { provide: NumberingService, useValue: mockNumbering },
      ],
    }).compile();

    service = module.get<InvoicesService>(InvoicesService);
  });

  it("recordStandalonePayment rounds a float-drift excess before writing the AdvancePayment (100 - 33.33 - 33.33 - 33.33)", async () => {
    prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 1 });
    prisma.invoice.findFirst.mockResolvedValue({
      id: "inv-1",
      status: "SENT",
      total: 100,
      dueDate: null,
      payments: [],
    });
    prisma.invoicePayment.findMany.mockResolvedValue([]);

    // Raw JS float math: 100 - (33.33 + 33.33 + 33.33) = 0.010000000000005116, not a clean 0.01.
    const allocatedTotal = 33.33 + 33.33 + 33.33;
    expect(100 - allocatedTotal).not.toBe(0.01); // sanity: proves the drift is real, not assumed

    await service.recordStandalonePayment({
      customerId: "cust-1",
      totalAmount: 100,
      method: "CHECK",
      allocations: [
        { invoiceId: "inv-1", amount: 33.33 },
        { invoiceId: "inv-1", amount: 33.33 },
        { invoiceId: "inv-1", amount: 33.33 },
      ],
    } as any);

    expect(prisma.advancePayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: 0.01, balance: 0.01 }),
      }),
    );
  });

  describe("recordDeliveryPaymentInTx", () => {
    const inv = (over: any = {}) => ({
      id: "inv-1",
      total: 100,
      status: "SENT",
      dueDate: null,
      invoiceNumber: "INV-1",
      customerId: "cust-1",
      payments: [],
      ...over,
    });

    beforeEach(() => {
      jest.spyOn(service, "findOpenOrderDraft").mockResolvedValue(null as any);
      jest.spyOn(service, "reconcileOrderDeliveredInvoices").mockResolvedValue(undefined as any);
      jest.spyOn(service, "createInvoiceFromOrder").mockResolvedValue([] as any);
      prisma.paymentCounter.upsert.mockResolvedValue({ next: 1 } as any);
      prisma.invoice.update.mockResolvedValue({} as any);
      prisma.advancePayment.create.mockResolvedValue({ id: "adv-1" } as any);
      // SA-404f N1: the under-lock re-read sees each invoice as listed (nothing voided meanwhile).
      prisma.invoice.findUnique.mockImplementation(async ({ where }: any) =>
        ((await prisma.invoice.findMany.mock.results.at(-1)?.value) ?? []).find(
          (r: any) => r.id === where.id,
        ),
      );
    });

    it("rounds the leftover excess before writing the AdvancePayment", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.invoice.findMany.mockResolvedValue([inv({ total: 33.33 })]);

      // Driver collects 100 against one $33.33 invoice: excess = 100 - 33.33 = 66.67, clean at
      // this scale, but the write must still go through roundMoney (defense against drift on a
      // larger, multi-invoice allocation loop -- see recordStandalonePayment's own pin above).
      await service.recordDeliveryPaymentInTx(
        prisma as any,
        new AfterCommit(),
        ["ord-1"],
        100,
        "CASH",
      );

      expect(prisma.advancePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amount: 66.67, balance: 66.67 }),
        }),
      );
    });
  });
});
