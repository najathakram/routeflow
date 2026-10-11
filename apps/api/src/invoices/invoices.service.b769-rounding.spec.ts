// Prevent Jest from traversing ESM-only dependencies (mirrors invoices.service.spec.ts).
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
import { BadRequestException } from "@nestjs/common";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

// B769: split into its own file rather than grown inline — invoices.service.spec.ts is
// already at its size-ratchet ceiling (see common/size-ratchet.spec.ts).
describe("InvoicesService — B769 money rounding", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: { sendInvoice: jest.fn() } },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
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
        {
          provide: CreditNotesService,
          useValue: { autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0 }) },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
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
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();

    service = module.get(InvoicesService);
  });

  it("REG-B769 recordStandalonePayment rounds each allocation before writing AND before summing for excess", async () => {
    prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 1 });
    prisma.invoice.findFirst.mockResolvedValue({
      id: "inv-1",
      status: InvoiceStatus.SENT,
      total: 1000,
      dueDate: null,
      payments: [],
    });
    prisma.invoicePayment.findMany.mockResolvedValue([]);

    // Verified against the real roundMoney (packages/pricing/src/pricing.ts) directly, not
    // hand-traced: 33.335 rounds to 33.34; the raw JS float sum of three is 100.005, but the
    // sum of three ROUNDED 33.34s is 100.02 — a different total. totalAmount is set to that
    // CORRECT rounded total (100.02): unrounded, allocatedTotal (100.005) leaves a stray
    // excess of ~0.015 that today wrongly mints a sub-cent AdvancePayment; rounded first,
    // excess is exactly 0 and no AdvancePayment should exist.
    await service.recordStandalonePayment({
      customerId: "cust-1",
      totalAmount: 100.02,
      method: "CASH",
      allocations: [
        { invoiceId: "inv-1", amount: 33.335 },
        { invoiceId: "inv-1", amount: 33.335 },
        { invoiceId: "inv-1", amount: 33.335 },
      ],
    } as any);

    const calls = prisma.invoicePayment.create.mock.calls;
    expect(calls).toHaveLength(3);
    for (const [args] of calls) {
      expect((args as any).data.amount).toBe(33.34);
    }
    expect(prisma.advancePayment.create).not.toHaveBeenCalled();
  });

  // ─── SA-112: the two required changes ───────────────────────────────────────────────────────

  const oneInvoice = () => {
    prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 1 });
    prisma.invoice.findFirst.mockResolvedValue({
      id: "inv-1",
      status: InvoiceStatus.SENT,
      total: 1000,
      dueDate: null,
      payments: [],
    });
    prisma.invoicePayment.findMany.mockResolvedValue([]);
  };

  it("REG-SA-112a: the excess advance is written ROUNDED (100.004 − 80.00 → 20.00, never 20.004)", async () => {
    oneInvoice();

    const res = await service.recordStandalonePayment({
      customerId: "cust-1",
      totalAmount: 100.004,
      method: "CASH",
      allocations: [
        { invoiceId: "inv-1", amount: 50.001 },
        { invoiceId: "inv-1", amount: 30 },
      ],
    } as any);

    expect(prisma.advancePayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 20, balance: 20 }),
    });
    expect(res.excess).toBe(20);
  });

  it("REG-SA-112b: allocations adding up to MORE than the payment are refused before any write", async () => {
    oneInvoice();

    const err = await service
      .recordStandalonePayment({
        customerId: "cust-1",
        totalAmount: 100,
        method: "CASH",
        allocations: [
          { invoiceId: "inv-1", amount: 60 },
          { invoiceId: "inv-1", amount: 40.01 },
        ],
      } as any)
      .catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      code: "ALLOCATIONS_EXCEED_PAYMENT",
      allocatedTotal: 100.01,
      totalAmount: 100,
    });
    // Before the B269 payment-number reservation: nothing is written, no number is burned.
    expect(prisma.paymentCounter.upsert).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    expect(prisma.advancePayment.create).not.toHaveBeenCalled();
  });

  it("PIN-SA-112: allocations exactly equal to the payment are accepted, with no advance", async () => {
    oneInvoice();

    const res = await service.recordStandalonePayment({
      customerId: "cust-1",
      totalAmount: 100,
      method: "CASH",
      allocations: [
        { invoiceId: "inv-1", amount: 60 },
        { invoiceId: "inv-1", amount: 40 },
      ],
    } as any);

    expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(2);
    expect(prisma.advancePayment.create).not.toHaveBeenCalled();
    expect(res.excess).toBe(0);
  });
});
