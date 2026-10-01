/**
 * SA-628 / B946: processRefund mints an ITEMISED credit note (CreditNoteItem rows, no trackedCategoryId on them) counted by the
 * SAME per-line headroom credit notes use, so a credit note and a return refund can never together exceed a line's value.
 * REFUSES (409 RETURN_REFUND_OVER_LINE_HEADROOM), never clips. 2+ creditable invoices keep the lump sum (v1).
 * The real-Postgres proof is credit-notes/credit-return-line-cap.db.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, BadRequestException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

const LINE_A = { id: "line-a", productId: "pa", qty: 1, subtotal: 100 };
const LINE_B = { id: "line-b", productId: "pb", qty: 1, subtotal: 100 };
const order = (invoices: any[]) => ({
  id: "ord-1",
  orderNumber: "ORD-1",
  invoices,
  lineItems: [],
});
const invoice = (id: string, items = [LINE_A, LINE_B]) => ({
  id,
  invoiceNumber: id.toUpperCase(),
  status: "SENT",
  total: 200,
  createdAt: new Date("2026-01-01"),
  items,
});

describe("ReturnsService.processRefund: itemised refund under the shared per-line headroom (SA-628, B946)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotesCreate: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    creditNotesCreate = jest.fn().mockResolvedValue({ id: "cn-1" });
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CreditNotesService, useValue: { create: creditNotesCreate } },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ReturnsService);
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    // nothing credited yet unless a test says otherwise
    prisma.creditNoteItem.findMany.mockResolvedValue([]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.return.findMany.mockResolvedValue([]);
  });

  const withReturn = (ord: any, items = [{ productId: "pa", qty: 1 }]) =>
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      returnNumber: "RET-1",
      status: "RECEIVED",
      customerId: "cust-1",
      items,
      order: ord,
    });

  it("a whole-line refund mints a credit note WITH the line item (qty + amount), not a lump sum", async () => {
    withReturn(order([invoice("inv-1")]));
    await service.processRefund("ret-1");
    expect(creditNotesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: "inv-1",
        amount: 100,
        items: [{ invoiceItemId: "line-a", amount: 100, qty: 1 }],
      }),
      // receive() already reversed the returned regulated goods: the itemised refund must not reverse them again
      { ledgerReversedByReturn: true },
    );
  });

  it("RED REPRO (B946): $33.33 already credited on line A by a credit note => a full return of A is REFUSED 409 and nothing is minted", async () => {
    prisma.creditNoteItem.findMany.mockResolvedValue([
      { invoiceItemId: "line-a", amount: 33.33, qty: 0.333 },
    ]);
    withReturn(order([invoice("inv-1")]));
    const err = await service.processRefund("ret-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "RETURN_REFUND_OVER_LINE_HEADROOM" });
    expect(creditNotesCreate).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalled(); // refused BEFORE the RECEIVED->REFUNDED claim
  });

  it("A cannot borrow B's slack: A fully credited, a return of A is refused even though the invoice total has room", async () => {
    prisma.creditNoteItem.findMany.mockResolvedValue([
      { invoiceItemId: "line-a", amount: 100, qty: 1 },
    ]);
    withReturn(order([invoice("inv-1")]));
    await expect(service.processRefund("ret-1")).rejects.toMatchObject({
      response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" },
    });
  });

  it("the LEGACY term: an old itemless refund note for the same product counts (ReturnItem.qty x the line's linear value)", async () => {
    prisma.creditNote.findMany.mockResolvedValue([{ id: "cn-old" }]);
    prisma.return.findMany.mockResolvedValue([{ items: [{ productId: "pa", qty: 1 }] }]);
    withReturn(order([invoice("inv-1")]));
    await expect(service.processRefund("ret-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("a partial return of 1 of 2 pieces refunds exactly half the line and leaves the rest creditable", async () => {
    const two = { id: "line-a", productId: "pa", qty: 2, subtotal: 100 };
    withReturn(order([invoice("inv-1", [two, LINE_B])]), [{ productId: "pa", qty: 1 }]);
    await service.processRefund("ret-1");
    expect(creditNotesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 50,
        items: [{ invoiceItemId: "line-a", amount: 50, qty: 1 }],
      }),
      { ledgerReversedByReturn: true },
    );
  });

  it("2+ creditable invoices keep today's lump-sum credit against the latest invoice (v1)", async () => {
    withReturn(
      order([invoice("inv-1"), { ...invoice("inv-2"), createdAt: new Date("2026-02-01") }]),
    );
    await service.processRefund("ret-1");
    const arg = creditNotesCreate.mock.calls[0][0];
    expect(arg.invoiceId).toBe("inv-2");
    expect(arg.items).toBeUndefined();
  });

  it("an order with no invoice keeps the unsourced lump-sum credit", async () => {
    withReturn({
      ...order([]),
      lineItems: [{ productId: "pa", qty: 1, unitPrice: 100, subtotal: 100, status: "DELIVERED" }],
    });
    await service.processRefund("ret-1");
    expect(creditNotesCreate.mock.calls[0][0].items).toBeUndefined();
  });

  it("a RACE that took the headroom between the pre-check and the mint surfaces as the same 409 (claim compensated)", async () => {
    withReturn(order([invoice("inv-1")]));
    creditNotesCreate.mockRejectedValue(
      new BadRequestException({ code: "CREDIT_NOTE_OVER_HEADROOM", message: "over" }),
    );
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    await expect(service.processRefund("ret-1")).rejects.toMatchObject({
      response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" },
    });
    expect(prisma.return.updateMany).toHaveBeenCalledTimes(2); // the claim, then the B68 compensation back to RECEIVED
  });
});
