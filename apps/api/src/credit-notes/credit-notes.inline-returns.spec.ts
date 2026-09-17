/**
 * Returns Inside Order Creation — PR-1c additions to `CreditNotesService`: `mintStandaloneInTx`
 * (m-1), the §6.3 "met" exclusion in `autoApplyOldestCreditsInTx`, the system-owned-intent skip
 * in `syncOrderCreditSelections`, and `cancelStandaloneInTx` (m-5, used by
 * `InlineReturnsService.cancel()`).
 */
import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("CreditNotesService — PR-1c (m-1 mintStandaloneInTx, §6.3 met exclusion, m-5 cancel)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: {
    reverseCreditNoteEntries: jest.Mock;
    unreverseCreditNoteEntries: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    ledger = {
      reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
      unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: ledger },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.creditNote.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "cn-new", ...args.data }),
    );
  });

  // ─── m-1: mintStandaloneInTx ─────────────────────────────────────────────────

  describe("mintStandaloneInTx", () => {
    it("refuses a null tenant context BEFORE any write (REG-B267 parity)", async () => {
      await expect(
        service.mintStandaloneInTx(
          prisma,
          { customerId: "cust-1", amount: 30 },
          "CN-2026-0001",
          null,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.creditNote.create).not.toHaveBeenCalled();
    });

    it("404s a customer outside the tenant-scoped read (foreign-tenant refusal)", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(
        service.mintStandaloneInTx(
          prisma,
          { customerId: "cust-foreign", amount: 30 },
          "CN-2026-0001",
          "t1",
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.creditNote.create).not.toHaveBeenCalled();
    });

    it("mints a standalone (invoiceId: null) note for the exact amount, on the CALLER's tx", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", businessName: "Acme Co" });

      const cn = await service.mintStandaloneInTx(
        prisma,
        { customerId: "cust-1", amount: 30.005, reason: "Inline return RET-1" },
        "CN-2026-0001",
        "t1",
      );

      expect(prisma.creditNote.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            creditNoteNumber: "CN-2026-0001",
            customerId: "cust-1",
            invoiceId: null,
            amount: 30.01, // roundMoney
            status: "ISSUED",
          }),
        }),
      );
      expect(cn.customer).toEqual({ id: "cust-1", businessName: "Acme Co" });
    });

    it("refuses a non-positive amount", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      await expect(
        service.mintStandaloneInTx(prisma, { customerId: "cust-1", amount: 0 }, "CN-1", "t1"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── §6.3: "met" exclusion from the general oldest-first sweep ──────────────

  describe("autoApplyOldestCreditsInTx — §6.3 excludes an unmet inline-return credit from the general sweep", () => {
    function primeInvoice(total: number) {
      prisma.invoice.findUnique.mockResolvedValue({ id: "inv-other", total, payments: [] });
    }

    it("skips an INLINE-linked credit whose OWN carrying order still has an open balance", async () => {
      primeInvoice(50);
      prisma.creditNote.findMany.mockResolvedValue([
        { id: "cn-inline", amount: 50, amountUsed: 0, createdAt: new Date("2026-01-01") },
      ]);
      // This credit note IS an inline return's own CN…
      prisma.return.findFirst.mockResolvedValue({ orderId: "ord-carrying" });
      // …and its carrying order still owes money (open, non-VOID invoice).
      prisma.order.findFirst.mockResolvedValue({ status: "PENDING" });
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-carrying", total: 100, status: "SENT", payments: [] },
      ]);

      const result = await service.autoApplyOldestCreditsInTx(prisma, "inv-other", "cust-1");

      expect(result.applied).toBe(0);
    });

    it("applies an INLINE-linked credit once its OWN carrying order is met (fully paid)", async () => {
      primeInvoice(50);
      prisma.creditNote.findMany.mockResolvedValue([
        { id: "cn-inline", amount: 50, amountUsed: 0, createdAt: new Date("2026-01-01") },
      ]);
      prisma.return.findFirst.mockResolvedValue({ orderId: "ord-carrying" });
      prisma.order.findFirst.mockResolvedValue({ status: "PENDING" });
      // Carrying order's only invoice is fully paid — "met".
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-carrying",
          total: 100,
          status: "PAID",
          payments: [{ amount: 100, status: "PAID" }],
        },
      ]);
      prisma.invoice.findUnique
        .mockResolvedValueOnce({ id: "inv-other", total: 50, payments: [] }) // initial read
        .mockResolvedValue({ id: "inv-other", total: 50, payments: [] }); // applyCreditInTx's own reads
      prisma.creditNote.findUnique = jest.fn().mockResolvedValue({
        id: "cn-inline",
        amount: 50,
        amountUsed: 0,
      });

      const result = await service.autoApplyOldestCreditsInTx(prisma, "inv-other", "cust-1");

      expect(result.applied).toBe(50);
    });

    it("a carrying order that is CANCELLED counts as met — the credit sweeps normally", async () => {
      primeInvoice(50);
      prisma.creditNote.findMany.mockResolvedValue([
        { id: "cn-inline", amount: 50, amountUsed: 0, createdAt: new Date("2026-01-01") },
      ]);
      prisma.return.findFirst.mockResolvedValue({ orderId: "ord-carrying" });
      prisma.order.findFirst.mockResolvedValue({ status: "CANCELLED" });
      prisma.invoice.findUnique.mockResolvedValue({ id: "inv-other", total: 50, payments: [] });
      prisma.creditNote.findUnique = jest
        .fn()
        .mockResolvedValue({ id: "cn-inline", amount: 50, amountUsed: 0 });

      const result = await service.autoApplyOldestCreditsInTx(prisma, "inv-other", "cust-1");

      expect(result.applied).toBe(50);
    });

    it("an ORDINARY (non-inline) credit is never filtered by the §6.3 exclusion", async () => {
      primeInvoice(50);
      prisma.creditNote.findMany.mockResolvedValue([
        { id: "cn-ordinary", amount: 50, amountUsed: 0, createdAt: new Date("2026-01-01") },
      ]);
      // No INLINE Return points at this credit note.
      prisma.return.findFirst.mockResolvedValue(null);
      prisma.invoice.findUnique.mockResolvedValue({ id: "inv-other", total: 50, payments: [] });
      prisma.creditNote.findUnique = jest
        .fn()
        .mockResolvedValue({ id: "cn-ordinary", amount: 50, amountUsed: 0 });

      const result = await service.autoApplyOldestCreditsInTx(prisma, "inv-other", "cust-1");

      expect(result.applied).toBe(50);
    });
  });

  // ─── §2.1/§6.3: syncOrderCreditSelections never drops/re-amounts a system-owned intent ──

  describe("syncOrderCreditSelections — never touches an INLINE return's own system-owned intent", () => {
    it("a staff selections list that omits the system-owned row leaves it in place (revert ⇒ dropped)", async () => {
      prisma.orderCreditNote.findMany.mockResolvedValue([
        { id: "ocn-1", orderId: "ord-1", creditNoteId: "cn-inline", amount: 30 },
      ]);
      // cn-inline is an INLINE return's own CN for THIS order.
      prisma.return.findFirst.mockResolvedValue({ id: "ret-1" });
      prisma.creditNote.findMany.mockResolvedValue([]); // validateSelectionsForCustomer: no selections to validate

      await service.syncOrderCreditSelections(prisma, "ord-1", "cust-1", []);

      expect(prisma.orderCreditNote.delete).not.toHaveBeenCalled();
      expect(prisma.invoicePayment.findMany).not.toHaveBeenCalled(); // pullBackOrderCreditPair never ran
    });

    it("an ORDINARY selection dropped from the list IS pulled back and deleted as before", async () => {
      prisma.orderCreditNote.findMany.mockResolvedValue([
        { id: "ocn-2", orderId: "ord-1", creditNoteId: "cn-manual", amount: 20 },
      ]);
      prisma.return.findFirst.mockResolvedValue(null); // not an inline-return intent
      prisma.creditNote.findMany.mockResolvedValue([]);
      prisma.invoicePayment.findMany.mockResolvedValue([]);

      await service.syncOrderCreditSelections(prisma, "ord-1", "cust-1", []);

      expect(prisma.orderCreditNote.delete).toHaveBeenCalledWith({ where: { id: "ocn-2" } });
    });
  });

  // ─── m-5: cancelStandaloneInTx ────────────────────────────────────────────────

  describe("cancelStandaloneInTx", () => {
    it("restores every non-VOID payment then voids the note and unreverses its ledger entries", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([
        { id: "pay-1", invoiceId: "inv-1", creditNoteId: "cn-1", amount: 30 },
      ]);
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        total: 100,
        dueDate: null,
        status: "SENT",
        payments: [{ amount: 30, status: "ACTIVE" }],
      });
      prisma.creditNote.findUnique.mockResolvedValue({
        id: "cn-1",
        amountUsed: 0,
        expiresAt: null,
      });
      // Post-restore re-read: amountUsed is back to 0.
      prisma.creditNote.findFirst.mockResolvedValue({ status: "ISSUED", amountUsed: 0 });
      prisma.creditNote.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.cancelStandaloneInTx(prisma, "cn-1");

      expect(prisma.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-1" } });
      expect(prisma.creditNote.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "cn-1", status: { not: "VOID" } },
          data: { status: "VOID" },
        }),
      );
      expect(ledger.unreverseCreditNoteEntries).toHaveBeenCalledWith(
        expect.objectContaining({ creditNoteId: "cn-1" }),
      );
      expect(result.restored).toBe(30);
    });

    it("m-5: refuses (RETURN_CREDIT_CONSUMED) when amountUsed can't be fully traced back to a restorable payment", async () => {
      // No InvoicePayment rows found at all, yet the note still shows consumption —
      // money spent through a path this method can't find and restore.
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.creditNote.findFirst.mockResolvedValue({ status: "APPLIED", amountUsed: 15 });

      await expect(service.cancelStandaloneInTx(prisma, "cn-1")).rejects.toThrow(
        "RETURN_CREDIT_CONSUMED",
      );
      expect(prisma.creditNote.updateMany).not.toHaveBeenCalled();
    });

    it("is a no-op on an already-VOID note", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.creditNote.findFirst.mockResolvedValue({ status: "VOID", amountUsed: 0 });

      const result = await service.cancelStandaloneInTx(prisma, "cn-1");

      expect(prisma.creditNote.updateMany).not.toHaveBeenCalled();
      expect(result.restored).toBe(0);
    });
  });
});
