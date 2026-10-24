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
 * B949 (HIGH money): a restore that hands a CREDIT_NOTE payment's amount back to a note whose source invoice was DELETED (the
 * SOURCE_DELETED marker) would turn a provenance-less credit into spendable wallet money. The single restore primitive
 * (restoreCreditFromPaymentInTx) refuses (409 CREDIT_NOTE_SOURCE_GONE), so EVERY path that restores refuses: voidInvoice and
 * order cancel/delete (releaseCreditsInTx), the explicit unapply, the order-edit untick (pullBackOrderCreditPair) and the
 * shrink. Atomic: checked before the first RESTORE of the operation (an operation such as an order cancel may already have written its own claim in the same transaction; the refusal rolls the whole transaction back, proved through the services in restore-source-gone-services.db.spec.ts). The only exception is the marked note's OWN void/cancel.
 * Real-Postgres proof: credit-notes/restore-source-gone.db.spec.ts.
 */
describe("CreditNotesService: B949 a SOURCE_DELETED note is never restored to spendable", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const MARKED = "cn-marked";
  const ORDINARY = "cn-ordinary";
  const pay = (id: string, creditNoteId: string, amount = 40) => ({
    id,
    invoiceId: "inv-1",
    creditNoteId,
    amount,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteVoided: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CommissionEngineService, useValue: { syncInvoiceCommissionSafe: jest.fn() } },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    // only MARKED carries the SOURCE_DELETED marker
    prisma.auditLog.findFirst.mockImplementation(async (args: any) =>
      args.where.entityId === MARKED && args.where.action === "SOURCE_DELETED"
        ? { id: "m-1" }
        : null,
    );
    prisma.creditNote.findUnique.mockImplementation(async (args: any) => ({
      id: args.where.id,
      creditNoteNumber: args.where.id === MARKED ? "CN-0007" : "CN-0008",
      amount: 100,
      amountUsed: 40,
      status: "ISSUED",
      expiresAt: null,
      appliedToInvoiceId: null,
    }));
    prisma.creditNote.findFirst.mockImplementation(async (args: any) => ({
      creditNoteNumber: args.where.id === MARKED ? "CN-0007" : "CN-0008",
    }));
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      total: 100,
      payments: [],
      dueDate: null,
      status: "PAID",
    });
    prisma.invoicePayment.delete.mockResolvedValue({});
    prisma.creditNote.update.mockResolvedValue({});
    prisma.invoice.update.mockResolvedValue({});
  });

  const writes = () => [
    prisma.invoicePayment.delete,
    prisma.invoicePayment.update,
    prisma.creditNote.update,
    prisma.invoice.update,
  ];
  const noWrites = () => writes().forEach((w) => expect(w).not.toHaveBeenCalled());
  const armPayments = (...p: any[]) => prisma.invoicePayment.findMany.mockResolvedValue(p);

  it("1. voidInvoice's release (releaseInvoiceCreditsInTx): a marked note's application refuses 409 CREDIT_NOTE_SOURCE_GONE with the way out, and NOTHING is written", async () => {
    armPayments(pay("p-1", MARKED));
    const err = await service.releaseInvoiceCreditsInTx(prisma, "inv-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "CREDIT_NOTE_SOURCE_GONE" });
    expect(err.getResponse().message).toBe(
      "Credit note CN-0007 came from a deleted invoice. Void that credit note first, then try again.",
    );
    noWrites();
  });

  it("2. an ORDINARY note restores exactly as before (the payment goes, the note is restored)", async () => {
    armPayments(pay("p-1", ORDINARY));
    const out = await service.releaseInvoiceCreditsInTx(prisma, "inv-1");
    expect(out).toEqual([expect.objectContaining({ creditNoteId: ORDINARY, amount: 40 })]);
    expect(prisma.invoicePayment.delete).toHaveBeenCalledTimes(1);
    expect(prisma.creditNote.update).toHaveBeenCalledTimes(1);
  });

  it("3. ATOMIC: an invoice paid by an ordinary note AND a marked one is refused whole; the ordinary note is NOT restored first", async () => {
    armPayments(pay("p-ord", ORDINARY), pay("p-mark", MARKED)); // the ordinary one is processed first
    await expect(service.releaseInvoiceCreditsInTx(prisma, "inv-1")).rejects.toMatchObject({
      response: { code: "CREDIT_NOTE_SOURCE_GONE" },
    });
    noWrites();
  });

  it("4. nothing to restore (the query excludes VOID payments) never reads the marker or refuses", async () => {
    armPayments();
    await expect(service.releaseInvoiceCreditsInTx(prisma, "inv-1")).resolves.toEqual([]);
    expect(prisma.invoicePayment.findMany.mock.calls[0][0].where.status).toEqual({ not: "VOID" });
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
  });

  it("5. order cancel/delete (releaseOrderCreditsInTx) refuses too", async () => {
    armPayments(pay("p-1", MARKED));
    prisma.orderCreditNote.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.releaseOrderCreditsInTx(prisma, "ord-1")).rejects.toMatchObject({
      response: { code: "CREDIT_NOTE_SOURCE_GONE" },
    });
    noWrites();
    expect(prisma.orderCreditNote.deleteMany).not.toHaveBeenCalled(); // the intents are kept
  });

  it("6. the explicit unapply (unapplyFromInvoice) refuses", async () => {
    armPayments(pay("p-1", MARKED));
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(prisma));
    await expect(service.unapplyFromInvoice(MARKED, "inv-1")).rejects.toMatchObject({
      response: { code: "CREDIT_NOTE_SOURCE_GONE" },
    });
    noWrites();
  });

  it("7. the order-edit untick (pullBackOrderCreditPair) refuses", async () => {
    armPayments(pay("p-1", MARKED));
    await expect(
      (service as any).pullBackOrderCreditPair(prisma, "ord-1", MARKED),
    ).rejects.toMatchObject({
      response: { code: "CREDIT_NOTE_SOURCE_GONE" },
    });
    noWrites();
  });

  it("8. the marked note's OWN void/cancel is the one exception: the restore runs (the note ends VOID, nothing becomes spendable)", async () => {
    const restore = (service as any).restoreCreditFromPaymentInTx.bind(service);
    await expect(
      restore(prisma, null, pay("p-1", MARKED), undefined, { voidingNoteId: MARKED }),
    ).resolves.toBe(40);
    expect(prisma.invoicePayment.delete).toHaveBeenCalledTimes(1);
    // ...and the two own-void callers really pass the flag
    const spy = jest.spyOn(service as any, "restoreCreditFromPaymentInTx").mockResolvedValue(0);
    prisma.creditNote.findFirst.mockResolvedValue({ status: "ISSUED", amountUsed: 0 });
    armPayments(pay("p-2", MARKED));
    await service.cancelStandaloneInTx(prisma, MARKED).catch(() => undefined);
    expect(spy.mock.calls[0][4]).toEqual({ voidingNoteId: MARKED });
  });

  it("8b. the exception is scoped to THAT note: voiding note A never restores a marked note B (no global flag)", async () => {
    const restore = (service as any).restoreCreditFromPaymentInTx.bind(service);
    await expect(
      restore(prisma, null, pay("p-1", MARKED), undefined, { voidingNoteId: ORDINARY }),
    ).rejects.toMatchObject({ response: { code: "CREDIT_NOTE_SOURCE_GONE" } });
    noWrites();
  });

  it("zero writes after the 409 on EVERY refusing path, and no caller swallows it (the throw reaches the caller)", async () => {
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(prisma));
    prisma.orderCreditNote.deleteMany.mockResolvedValue({ count: 0 });
    const paths: Array<() => Promise<unknown>> = [
      () => service.releaseInvoiceCreditsInTx(prisma, "inv-1"),
      () => service.releaseOrderCreditsInTx(prisma, "ord-1"),
      () => service.unapplyFromInvoice(MARKED, "inv-1"),
      () => (service as any).pullBackOrderCreditPair(prisma, "ord-1", MARKED),
    ];
    for (const run of paths) {
      armPayments(pay("p-1", ORDINARY), pay("p-2", MARKED));
      await expect(run()).rejects.toMatchObject({ response: { code: "CREDIT_NOTE_SOURCE_GONE" } });
      noWrites();
    }
  });

  it("N2: the settle SHRINK refuses too: an invoice shrunk below what a marked note's application covers is refused whole, before any restore", async () => {
    const at = (n: number) => new Date(2026, 0, n);
    prisma.orderCreditNote.findMany.mockResolvedValue([]);
    prisma.creditNoteApplyBlock.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv-1",
        total: 70, // shrunk from 100: $30 over-collected
        payments: [
          {
            id: "p-m",
            method: "CREDIT_NOTE",
            creditNoteId: MARKED,
            amount: 40,
            status: "PAID",
            createdAt: at(1),
          },
          {
            id: "p-o",
            method: "CREDIT_NOTE",
            creditNoteId: ORDINARY,
            amount: 60,
            status: "PAID",
            createdAt: at(2),
          },
        ],
      },
    ]);
    await expect(service.settleOrderCreditsInTx(prisma, "ord-1", "t-1")).rejects.toMatchObject({
      response: { code: "CREDIT_NOTE_SOURCE_GONE" },
    });
    noWrites();
  });

  it("N1 (accepted, fail-closed): the shrink pre-pass reads EVERY credit payment of the invoice, so a marked note refuses the settle even when the excess would only come out of the newer ordinary note", async () => {
    const at = (n: number) => new Date(2026, 0, n);
    prisma.orderCreditNote.findMany.mockResolvedValue([]);
    prisma.creditNoteApplyBlock.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv-1",
        total: 90, // only $10 over: the newest (ordinary) payment alone would cover it
        payments: [
          {
            id: "p-m",
            method: "CREDIT_NOTE",
            creditNoteId: MARKED,
            amount: 40,
            status: "PAID",
            createdAt: at(1),
          },
          {
            id: "p-o",
            method: "CREDIT_NOTE",
            creditNoteId: ORDINARY,
            amount: 60,
            status: "PAID",
            createdAt: at(2),
          },
        ],
      },
    ]);
    await expect(service.settleOrderCreditsInTx(prisma, "ord-1", "t-1")).rejects.toMatchObject({
      response: { code: "CREDIT_NOTE_SOURCE_GONE" },
    });
    noWrites();
  });

  it("9. after the marked note is VOID-reversed first there is nothing to restore: the original operation succeeds and restores nothing to it", async () => {
    armPayments(); // the void reversal deleted its payments
    await expect(service.releaseInvoiceCreditsInTx(prisma, "inv-1")).resolves.toEqual([]);
    noWrites();
  });
});
