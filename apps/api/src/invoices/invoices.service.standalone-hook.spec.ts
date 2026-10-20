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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

// Row 615: split into its own file rather than grown inline — invoices.service.spec.ts is
// already at its size-ratchet ceiling (see common/size-ratchet.spec.ts).
describe("InvoicesService — row 615 standalone payment hook", () => {
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

  describe("SA-818 / row 615 — recordStandalonePayment's optional inTx hook", () => {
    const dto = () =>
      ({
        customerId: "cust-1",
        totalAmount: 150,
        method: "CASH",
        reference: "receipt 7",
        allocations: [{ invoiceId: "inv-1", amount: 100 }],
      }) as any;

    beforeEach(() => {
      prisma.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 3 });
      prisma.invoice.findFirst.mockResolvedValue({
        id: "inv-1",
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
        payments: [],
      });
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => ({
        id: "pay-1",
        ...data,
      }));
    });

    it("(e) a call with no hook writes the same rows, with the buyer's reference as entered", async () => {
      const plain = await service.recordStandalonePayment(dto());
      const plainRows = prisma.invoicePayment.create.mock.calls.map(([a]: any) => a.data);
      const plainAdvance = prisma.advancePayment.create.mock.calls.map(([a]: any) => a.data);
      prisma.invoicePayment.create.mockClear();
      prisma.advancePayment.create.mockClear();

      const hooked = await service.recordStandalonePayment(dto(), {
        inTx: async () => undefined,
      });
      const hookedRows = prisma.invoicePayment.create.mock.calls.map(([a]: any) => a.data);
      const hookedAdvance = prisma.advancePayment.create.mock.calls.map(([a]: any) => a.data);

      const strip = (rows: any[]) =>
        rows.map(({ paymentGroupId: _g, paidAt: _p, ...rest }: any) => rest);
      expect(strip(hookedRows)).toEqual(strip(plainRows));
      expect(strip(hookedAdvance.map((a) => ({ ...a, receivedAt: 0 })))).toEqual(
        strip(plainAdvance.map((a) => ({ ...a, receivedAt: 0 }))),
      );
      expect(plainRows[0].reference).toBe("receipt 7");
      expect(plainAdvance[0].amount).toBe(50);
      expect(Object.keys(plain).sort()).toEqual(["excess", "paymentGroupId", "payments"]);
      expect(Object.keys(hooked).sort()).toEqual(["excess", "paymentGroupId", "payments"]);
      expect(plain.excess).toBe(50);
    });

    it("runs the hook inside the transaction, after the payment rows and the excess advance, with the result", async () => {
      const inTx = jest.fn().mockResolvedValue(undefined);

      const result = await service.recordStandalonePayment(dto(), { inTx });

      expect(inTx).toHaveBeenCalledTimes(1);
      const [txArg, resArg] = inTx.mock.calls[0];
      expect(txArg).toBeDefined();
      expect(resArg).toBe(result);
      expect(resArg.paymentGroupId).toEqual(expect.any(String));
      const hookAt = inTx.mock.invocationCallOrder[0];
      expect(prisma.invoicePayment.create.mock.invocationCallOrder[0]).toBeLessThan(hookAt);
      expect(prisma.advancePayment.create.mock.invocationCallOrder[0]).toBeLessThan(hookAt);
    });

    it("a hook that throws rejects the call with its error (the transaction rolls back)", async () => {
      await expect(
        service.recordStandalonePayment(dto(), {
          inTx: async () => {
            throw new Error("claim lost");
          },
        }),
      ).rejects.toThrow("claim lost");
    });
  });
});
