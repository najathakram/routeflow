// Prevent Jest from traversing ESM-only dependencies (mirrors invoices.service.spec.ts).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

// Row 498: a payment with a reference runs under the `payment-ref` advisory lock (a real pooled connection); this
// unit spec has no database, so the lock is a pass-through here (its behaviour is payment-ref-dedupe.writers.spec.ts).
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => unknown) => ({
    acquired: true,
    value: await fn(),
  })),
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
import { API_ERROR_CODES } from "../common/api-error-codes";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

// B1385: its own file (invoices.service.spec.ts is at its size-ratchet ceiling).
describe("InvoicesService — B1385 a draft payment is not credit", () => {
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
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn(), getAll: jest.fn().mockResolvedValue({}), set: jest.fn() },
        },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
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

  const write = (over: Record<string, unknown>, opts: any = { source: "STAFF_ALLOCATION" }) =>
    service.recordStandalonePayment(
      { customerId: "cust-1", totalAmount: 500, method: "CASH", allocations: [], ...over } as any,
      opts,
    );
  const nothingWritten = () => {
    expect(prisma.advancePayment.create).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    expect(prisma.paymentCounter.upsert).not.toHaveBeenCalled(); // refused before a payment number is burned
  };

  beforeEach(() => {
    prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 3 });
    prisma.invoicePayment.findMany.mockResolvedValue([]);
    prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => ({
      id: "pay-1",
      ...data,
    }));
    prisma.advancePayment.create.mockImplementation(async ({ data }: any) => ({
      id: "ap-1",
      ...data,
    }));
  });

  it("a DRAFT $500 with no allocation is refused: coded 400, no advance row, no payment row", async () => {
    const err: any = await write({ status: "DRAFT" }).catch((e: unknown) => e);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({ code: API_ERROR_CODES.DRAFT_PAYMENT_HAS_EXCESS }),
    );
    nothingWritten();
  });

  it("a DRAFT with a $200 leftover after a $300 allocation is refused the same way", async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: "inv-1",
      status: InvoiceStatus.SENT,
      total: 300,
      dueDate: null,
      payments: [],
    });
    const err: any = await write({
      status: "DRAFT",
      allocations: [{ invoiceId: "inv-1", amount: 300 }],
    }).catch((e: unknown) => e);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({ code: API_ERROR_CODES.DRAFT_PAYMENT_HAS_EXCESS }),
    );
    nothingWritten();
  });

  it("control: a PAID $500 with no allocation still becomes an advance (SA-112)", async () => {
    await write({ status: "PAID" });
    expect(prisma.advancePayment.create).toHaveBeenCalledTimes(1);
  });

  describe("(c) a standalone payment never lands on a DRAFT invoice", () => {
    const invoiceIs = (status: InvoiceStatus) =>
      prisma.invoice.findFirst.mockResolvedValue({
        id: "inv-1",
        status,
        total: 100,
        dueDate: null,
        payments: [],
      });

    it("a staff $100 allocation onto a DRAFT invoice is refused, nothing written", async () => {
      invoiceIs(InvoiceStatus.DRAFT);
      await expect(
        write({ totalAmount: 100, allocations: [{ invoiceId: "inv-1", amount: 100 }] }),
      ).rejects.toThrow(/draft/);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it("control: the same allocation onto a SENT invoice is written", async () => {
      invoiceIs(InvoiceStatus.SENT);
      await write({ totalAmount: 100, allocations: [{ invoiceId: "inv-1", amount: 100 }] });
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("the STRIPE_SETTLE exemption is exactly one clause wide (SA note on #4512)", () => {
    const settle = { source: "STRIPE_SETTLE" } as any;
    const invoiceIs = (status: InvoiceStatus) =>
      prisma.invoice.findFirst.mockResolvedValue({
        id: "inv-1",
        status,
        total: 100,
        dueDate: null,
        payments: [],
      });

    it("1a: a STRIPE_SETTLE DRAFT with a leftover is still refused (the refusal does not ride the exemption)", async () => {
      const err: any = await write({ status: "DRAFT" }, settle).catch((e: unknown) => e);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ code: API_ERROR_CODES.DRAFT_PAYMENT_HAS_EXCESS }),
      );
      nothingWritten();
    });

    it("1b: a staff allocation on a DRAFT invoice is refused; the same one through STRIPE_SETTLE records PAID", async () => {
      const alloc = { totalAmount: 100, allocations: [{ invoiceId: "inv-1", amount: 100 }] };
      invoiceIs(InvoiceStatus.DRAFT);
      await expect(write(alloc)).rejects.toThrow(/is a draft/);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();

      await write(alloc, settle);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      expect(prisma.invoicePayment.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ amount: 100, status: "PAID" }),
      );
    });
  });
});
