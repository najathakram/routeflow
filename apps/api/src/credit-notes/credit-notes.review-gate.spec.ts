import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-1124 PR-1b: credit-note application (credit-notes.service.ts, the `invoicePayment.create` in applyCreditInTx) is
 * GATED. A STAFF act (the manual apply) refuses with 409 ORDER_REVIEW_REQUIRED while the invoice's order carries an
 * open PRICE_CHANGED_OFFLINE flag; the two SYSTEM callers (the send-time sweep and the order-intent settle, which run
 * inside an order edit or a send) skip a flagged order instead, so an order edit never fails on a review it did not
 * ask for. Each row also pins master's value for the same call on an unflagged order.
 */
describe("CreditNotesService: the review gate (SA-1124 PR-1b)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
  });

  const open = () =>
    prisma.orderReviewFlag.findMany.mockResolvedValue([{ kind: "PRICE_CHANGED_OFFLINE" }] as any);
  const resolved = () => prisma.orderReviewFlag.findMany.mockResolvedValue([] as any);
  const note = (id: string, amount: number) => ({
    id,
    creditNoteNumber: `CN-${id}`,
    amount,
    amountUsed: 0,
    status: "ISSUED",
    customerId: "c1",
    expiresAt: null,
    appliedToInvoiceId: null,
    createdAt: new Date("2026-01-01"),
  });
  const invoice = (id: string, total: number) => ({
    id,
    orderId: "ord-1",
    customerId: "c1",
    total,
    dueDate: null,
    status: "SENT",
    payments: [] as any[],
  });

  describe("the manual apply", () => {
    beforeEach(() => {
      prisma.creditNote.findUnique.mockResolvedValue(note("cn-a", 50));
      prisma.invoice.findUnique.mockResolvedValue(invoice("inv-1", 40));
    });

    it("409 ORDER_REVIEW_REQUIRED while the order is flagged, no payment row", async () => {
      open();
      const err = await service.applyToInvoice("cn-a", "inv-1").catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: "ORDER_REVIEW_REQUIRED",
        orderId: "ord-1",
        openKinds: ["PRICE_CHANGED_OFFLINE"],
      });
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it("applies once the flag is resolved (master's value)", async () => {
      resolved();
      await service.applyToInvoice("cn-a", "inv-1");
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    });

    it("an invoice with no order never asks the gate", async () => {
      open();
      prisma.invoice.findUnique.mockResolvedValue({ ...invoice("inv-1", 40), orderId: null });
      await service.applyToInvoice("cn-a", "inv-1");
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      expect(prisma.orderReviewFlag.findMany).not.toHaveBeenCalled();
    });
  });

  describe("the send-time sweep (a system caller: skips, never throws)", () => {
    beforeEach(() => {
      (prisma.tenantConfig.findUnique as jest.Mock).mockResolvedValue({
        creditAutoApplyOnSend: true,
      });
      prisma.invoice.findUnique.mockResolvedValue(invoice("inv-1", 30));
      prisma.creditNote.findMany.mockResolvedValue([note("cn-a", 50)]);
    });

    it("applies nothing to a flagged order's invoice, and does not throw", async () => {
      open();
      const res = await service.autoApplyOldestCreditsInTx(prisma as any, "inv-1", "c1");
      expect(res).toEqual({ applied: 0, invoiceStatus: null });
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it("applies on an unflagged order (master's value)", async () => {
      resolved();
      const res = await service.autoApplyOldestCreditsInTx(prisma as any, "inv-1", "c1");
      expect(res.applied).toBe(30);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("the order-intent settle (a system caller: skips, never throws)", () => {
    beforeEach(() => {
      prisma.orderCreditNote.findMany.mockResolvedValue([
        { id: "ocn-1", creditNoteId: "cn-a", amount: 20, creditNote: note("cn-a", 50) },
      ]);
      prisma.invoice.findMany.mockResolvedValue([invoice("inv-1", 100)]);
      prisma.creditNote.findUnique.mockResolvedValue(note("cn-a", 50));
      prisma.invoice.findUnique.mockImplementation((args: any) =>
        Promise.resolve(invoice(args.where.id, 100)),
      );
    });

    it("applies nothing while the order is flagged (the intent waits for the review)", async () => {
      open();
      const res = await service.settleOrderCreditsInTx(prisma as any, "ord-1");
      expect(res.applied).toBe(0);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it("applies once the flag is resolved (master's value)", async () => {
      resolved();
      const res = await service.settleOrderCreditsInTx(prisma as any, "ord-1");
      expect(res.applied).toBe(20);
    });
  });
});
