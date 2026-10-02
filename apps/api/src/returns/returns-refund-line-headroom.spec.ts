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
    prisma.invoice.findMany.mockResolvedValue([]); // B947: the order pool read (empty unless a test sets it)
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

  it("B947: 2+ creditable invoices: a refund whose product line on the OLDER invoice is already credited is REFUSED 409 before the claim, and nothing is minted", async () => {
    // pool read: X (older) carries A and B, Y (latest) carries C; A on X is fully credited by a credit note item
    prisma.invoice.findMany.mockResolvedValue([
      { id: "inv-1", items: [LINE_A, LINE_B] },
      { id: "inv-2", items: [{ id: "line-c", productId: "pc", qty: 1, subtotal: 100 }] },
    ]);
    prisma.creditNoteItem.findMany.mockResolvedValue([
      { invoiceItemId: "line-a", amount: 100, qty: 1 },
    ]);
    withReturn(
      order([invoice("inv-1"), { ...invoice("inv-2"), createdAt: new Date("2026-02-01") }]),
    );
    const err = await service.processRefund("ret-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "RETURN_REFUND_OVER_LINE_HEADROOM" });
    expect(creditNotesCreate).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalled(); // before the RECEIVED->REFUNDED claim
  });

  it("B947: a 2+ invoice refund that fits still mints the SAME lump sum on the latest invoice, and hands create() the returned products to re-check under its locks", async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: "inv-1", items: [LINE_A, LINE_B] },
      { id: "inv-2", items: [{ id: "line-c", productId: "pc", qty: 1, subtotal: 100 }] },
    ]);
    withReturn(
      order([invoice("inv-1"), { ...invoice("inv-2"), createdAt: new Date("2026-02-01") }]),
    );
    await service.processRefund("ret-1");
    const [arg, opts] = creditNotesCreate.mock.calls[0];
    expect(arg.invoiceId).toBe("inv-2");
    expect(arg.items).toBeUndefined(); // the mint is unchanged: no items
    expect(opts).toEqual({
      ledgerReversedByReturn: true,
      pooledRefund: [{ productId: "pa", qty: 1 }],
      returnId: "ret-1", // linked to the note INSIDE the mint tx, so the pool attributes the lump the moment it commits
    });
  });

  it("B947: a racing credit note that takes the pooled room between the check and the mint (create() refuses OVER_HEADROOM) is the SAME 409, and the claim is compensated back to RECEIVED", async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: "inv-1", items: [LINE_A, LINE_B] },
      { id: "inv-2", items: [{ id: "line-c", productId: "pc", qty: 1, subtotal: 100 }] },
    ]);
    creditNotesCreate.mockRejectedValue(
      new BadRequestException({ code: "CREDIT_NOTE_OVER_HEADROOM", pooled: true, message: "over" }),
    );
    withReturn(
      order([invoice("inv-1"), { ...invoice("inv-2"), createdAt: new Date("2026-02-01") }]),
    );
    await expect(service.processRefund("ret-1")).rejects.toMatchObject({
      response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" },
    });
    expect(prisma.return.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ret-1", status: "REFUNDED", creditNoteId: null } }),
    );
  });

  it("B947 N5: the latest invoice's own TOTAL cap (an OVER_HEADROOM that is not the pool's) keeps its own error: never relabelled 'line is worth', and the claim is still compensated", async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: "inv-1", items: [LINE_A, LINE_B] },
      { id: "inv-2", items: [{ id: "line-c", productId: "pc", qty: 1, subtotal: 100 }] },
    ]);
    creditNotesCreate.mockRejectedValue(
      new BadRequestException({ code: "CREDIT_NOTE_OVER_HEADROOM", message: "invoice total" }),
    );
    withReturn(
      order([invoice("inv-1"), { ...invoice("inv-2"), createdAt: new Date("2026-02-01") }]),
    );
    const err = await service.processRefund("ret-1").catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: "CREDIT_NOTE_OVER_HEADROOM" });
    expect(prisma.return.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ret-1", status: "REFUNDED", creditNoteId: null } }),
    );
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

  it("SA-628a: the 409 carries {productId, requested, remaining} in money and qty", async () => {
    prisma.creditNoteItem.findMany.mockResolvedValue([
      { invoiceItemId: "line-a", amount: 33.33, qty: 0.333 },
    ]);
    withReturn(order([invoice("inv-1")]));
    const err = await service.processRefund("ret-1").catch((e) => e);
    expect(err.getResponse()).toMatchObject({
      code: "RETURN_REFUND_OVER_LINE_HEADROOM",
      productId: "pa",
      requested: 100,
      remaining: 66.67,
    });
  });

  it("SA-628a: qty room is left but the money is short => refused, never clipped", async () => {
    const ten = { id: "line-a", productId: "pa", qty: 10, subtotal: 100 };
    prisma.creditNoteItem.findMany.mockResolvedValue([
      { invoiceItemId: "line-a", amount: 50, qty: 1 },
    ]);
    withReturn(order([invoice("inv-1", [ten, LINE_B])]), [{ productId: "pa", qty: 9 }]);
    await expect(service.processRefund("ret-1")).rejects.toMatchObject({
      response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM", requested: 90, remaining: 50 },
    });
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  it("SA-628a B1: a $0 (free) line takes its qty at amount 0 and is not refused; an all-free refund mints no credit note", async () => {
    const free = { id: "line-a", productId: "pa", qty: 2, subtotal: 0 };
    withReturn(order([invoice("inv-1", [free, LINE_B])]), [{ productId: "pa", qty: 1 }]);
    await service.processRefund("ret-1");
    expect(creditNotesCreate).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REFUNDED" }) }),
    );
  });

  it("SA-628a: a PRICED line next to a free line of the same product is itemised paid-first at the pooled price (SA-628b)", async () => {
    const free = { id: "line-f", productId: "pa", qty: 2, subtotal: 0 };
    const paid = { id: "line-a", productId: "pa", qty: 10, subtotal: 100 };
    withReturn(order([invoice("inv-1", [paid, free])]), [{ productId: "pa", qty: 11 }]);
    await service.processRefund("ret-1");
    expect(creditNotesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 91.67,
        items: [
          { invoiceItemId: "line-a", amount: 91.67, qty: 10 },
          { invoiceItemId: "line-f", amount: 0, qty: 1 },
        ],
      }),
      { ledgerReversedByReturn: true },
    );
  });

  it("SA-628a: the preview prices the same pooled price the mint itemises (a product split across lines of different prices)", async () => {
    const cheap = { id: "line-c", productId: "pa", qty: 1, subtotal: 50 };
    const dear = { id: "line-d", productId: "pa", qty: 1, subtotal: 100 };
    const ret = {
      id: "ret-1",
      kind: "STANDARD",
      status: "RECEIVED",
      items: [{ productId: "pa", qty: 1 }],
      order: order([invoice("inv-1", [dear, cheap])]),
    };
    // SA-628b: master's pooled price ($75), the same number the mint itemises
    withReturn(ret.order);
    await service.processRefund("ret-1");
    expect(creditNotesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 75 }),
      expect.anything(),
    );
    expect((service as any).priceReturn(ret.items, ret.order, new Map()).amount).toBe(75);
  });
});
