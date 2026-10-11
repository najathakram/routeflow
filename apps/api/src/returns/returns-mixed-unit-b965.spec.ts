/**
 * B965 / B967 (SA-628l/m): a STANDARD return's qty is in its order line's OWN unit, so a product sold on lines with different pack
 * factors (2 boxes of 12 on one line, 12 loose pieces on another) has no single piece count to refund. `create()` already refuses
 * to record such a return (SA-158, 409 "return it inline, per line"); this is the REFUND door's safety net for legacy RECEIVED
 * rows: refused 409 RETURN_MIXED_UNIT_PRODUCT before the claim, nothing minted. EXTERNAL_REFUND is refused the same way (B969). A
 * single-factor product (boxed or loose) is unchanged, and a 2+-invoice refund is checked against the pool in PIECES.
 */
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

const orderLine = (over: Record<string, unknown>) => ({
  id: "l1",
  productId: "pp",
  qty: 2,
  unitPrice: 60,
  subtotal: 120,
  status: "CONFIRMED",
  position: 0,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  product: { unitsPerBox: 12 },
  ...over,
});
// a box-unaware 2-box line (factor 12 once an invoice item proves the split) and a loose 12-piece line (own split: factor 1)
const BOX_LINE = orderLine({});
const LOOSE_LINE = orderLine({
  id: "l2",
  qty: 12,
  unitPrice: 5,
  subtotal: 60,
  position: 1,
  boxes: 0,
  pieces: 12,
  unitsPerBox: 12,
});
const BOX_PROOF = [{ orderItemId: "l1", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }];

const invItem = (id: string, over: Record<string, unknown>) => ({
  id,
  productId: "pp",
  qty: 2,
  subtotal: 120,
  boxes: null,
  pieces: null,
  unitsPerBox: 12,
  product: { unitsPerBox: 12 },
  ...over,
});
const invoice = (id: string, items: any[], over: Record<string, unknown> = {}) => ({
  id,
  invoiceNumber: id.toUpperCase(),
  status: "SENT",
  total: items.reduce((t, i) => t + i.subtotal, 0),
  createdAt: new Date("2026-01-01"),
  items,
  ...over,
});

describe("ReturnsService.processRefund — mixed-unit product at the refund door (B965)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotesCreate: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    // SA-737: the claim re-reads the Return's status under its row lock
    prisma.return.findFirst.mockResolvedValue({ id: "ret", status: "RECEIVED", kind: "STANDARD" });
    creditNotesCreate = jest.fn().mockResolvedValue({ id: "cn-1" });
    const mod = await Test.createTestingModule({
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
    prisma.creditNoteItem.findMany.mockResolvedValue([]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.return.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.invoiceItem.findMany.mockResolvedValue(BOX_PROOF);
  });

  const withReturn = (invoices: any[], lineItems: any[], items: any[], method?: string) => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      returnNumber: "RET-1",
      status: "RECEIVED",
      customerId: "cust-1",
      items,
      order: { id: "ord-1", orderNumber: "ORD-1", invoices, lineItems },
    });
    return method;
  };
  const mixedInvoice = () => [
    invoice("inv-1", [
      invItem("i1", {}),
      invItem("i2", { qty: 12, subtotal: 60, boxes: 0, pieces: 12 }),
    ]),
  ];

  it("RED REPRO: 2 boxes of 12 + 12 loose pieces, a standard return of 13 => 409 RETURN_MIXED_UNIT_PRODUCT before the claim, nothing minted", async () => {
    withReturn(mixedInvoice(), [BOX_LINE, LOOSE_LINE], [{ productId: "pp", qty: 13 }]);
    const err = await service.processRefund("ret-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "RETURN_MIXED_UNIT_PRODUCT" });
    expect(err.getResponse().message).toMatch(/inline return|manually/);
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  it("a boxed line beside a loose line with NO pack proof on the box line is refused the same way (basis unknown, not single-unit)", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    withReturn(mixedInvoice(), [BOX_LINE, LOOSE_LINE], [{ productId: "pp", qty: 1 }]);
    await expect(service.processRefund("ret-1")).rejects.toMatchObject({
      response: { code: "RETURN_MIXED_UNIT_PRODUCT" },
    });
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });

  it("2+ creditable invoices: the same refusal, before the pool is even read", async () => {
    withReturn(
      [
        invoice("inv-1", [invItem("i1", {})]),
        invoice("inv-2", [invItem("i2", { qty: 12, subtotal: 60, boxes: 0, pieces: 12 })], {
          createdAt: new Date("2026-02-01"),
        }),
      ],
      [BOX_LINE, LOOSE_LINE],
      [{ productId: "pp", qty: 1 }],
    );
    await expect(service.processRefund("ret-1")).rejects.toMatchObject({
      response: { code: "RETURN_MIXED_UNIT_PRODUCT" },
    });
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });

  it("EXTERNAL_REFUND on the same mixed return is refused too (B969): a mixed return has no refund amount to record, never a silent $0", async () => {
    withReturn(mixedInvoice(), [BOX_LINE, LOOSE_LINE], [{ productId: "pp", qty: 13 }]);
    await expect(
      service.processRefund("ret-1", { method: "EXTERNAL_REFUND" } as any),
    ).rejects.toMatchObject({ response: { code: "RETURN_MIXED_UNIT_PRODUCT" } });
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  it("a NEVER-INVOICED order is gated too: the order-line fallback would add boxes to pieces and mint with no cap", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    withReturn([], [BOX_LINE, LOOSE_LINE], [{ productId: "pp", qty: 12 }]);
    await expect(service.processRefund("ret-1")).rejects.toMatchObject({
      response: { code: "RETURN_MIXED_UNIT_PRODUCT" },
    });
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  it("single-unit BOXED product is unchanged: 1 of 2 boxes refunds half the line", async () => {
    // the legacy selling-unit shape: a box-unaware order line billed by ONE box-unaware invoice item (qty 2 boxes), no pack proof
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    withReturn([invoice("inv-1", [invItem("i1", {})])], [BOX_LINE], [{ productId: "pp", qty: 1 }]);
    await service.processRefund("ret-1");
    expect(creditNotesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 60, items: [{ invoiceItemId: "i1", amount: 60, qty: 1 }] }),
      { ledgerReversedByReturn: true, returnId: "ret-1" },
    );
  });

  it("single-unit LOOSE product is unchanged", async () => {
    withReturn(
      [invoice("inv-1", [invItem("i2", { qty: 12, subtotal: 60, boxes: 0, pieces: 12 })])],
      [LOOSE_LINE],
      [{ productId: "pp", qty: 6 }],
    );
    await service.processRefund("ret-1");
    expect(creditNotesCreate).toHaveBeenCalledWith(expect.objectContaining({ amount: 30 }), {
      ledgerReversedByReturn: true,
      returnId: "ret-1",
    });
  });
});

describe("ReturnsService.processRefund — the order pool in PIECES (B967)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotesCreate: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    // SA-737: the claim re-reads the Return's status under its row lock
    prisma.return.findFirst.mockResolvedValue({ id: "ret", status: "RECEIVED", kind: "STANDARD" });
    creditNotesCreate = jest.fn().mockResolvedValue({ id: "cn-1" });
    const mod = await Test.createTestingModule({
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
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.return.findMany.mockResolvedValue([]);
    prisma.invoiceItem.findMany.mockResolvedValue([
      { orderItemId: "l1", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 },
    ]);
  });

  // two creditable invoices, each 1 box of 12 ($120); a credit note item took 6 pieces (0.5 box) off the older one
  const twoBoxInvoices = () => [
    invoice("inv-1", [invItem("i1", { qty: 1, subtotal: 120 })]),
    // `total` carries room beyond the one line (e.g. other products), so the lump's own invoice cap does not bind here
    invoice("inv-2", [invItem("i2", { qty: 1, subtotal: 120 })], {
      createdAt: new Date("2026-02-01"),
      total: 400,
    }),
  ];
  const poolRead = () =>
    prisma.invoice.findMany.mockResolvedValue(
      // SA-773: the refundable remainder pools an order's invoices, so the rows carry their order (as stored rows do)
      twoBoxInvoices().map((i) => ({ id: i.id, orderId: "ord-1", items: i.items })),
    );
  const withReturn = (qty: number) =>
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      returnNumber: "RET-1",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "pp", qty }],
      order: {
        id: "ord-1",
        orderNumber: "ORD-1",
        invoices: twoBoxInvoices(),
        lineItems: [orderLine({})],
      },
    });
  const creditNoteItems = () =>
    prisma.creditNoteItem.findMany.mockImplementation(async (args: any) =>
      args.where.invoiceItemId.in.includes("i1")
        ? [{ invoiceItemId: "i1", amount: 60, qty: 0.5 }]
        : [],
    );

  it("12 per box, a credit note took 6 pieces: a standard return of 2 boxes (24 pieces) is REFUSED, room is 18 pieces", async () => {
    poolRead();
    creditNoteItems();
    withReturn(2);
    const err = await service.processRefund("ret-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "RETURN_REFUND_OVER_LINE_HEADROOM",
      qtyUnit: "pieces",
      remainingQty: 18,
    });
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  it("1.5 boxes (18 pieces) fits exactly, and the mint is handed PIECES (preview = mint)", async () => {
    poolRead();
    creditNoteItems();
    withReturn(1.5);
    await service.processRefund("ret-1");
    expect(creditNotesCreate.mock.calls[0][1]).toMatchObject({
      pooledRefund: [{ productId: "pp", qty: 18 }],
    });
  });

  it("a box-unaware line billed across SEVERAL invoice items has no factor to convert with: refused, never converted with the invoice's own factor", async () => {
    // l1 (2 boxes) was billed as two split invoice items (12 pieces each): the order line's unit is boxes, the pool's is pieces
    prisma.invoiceItem.findMany.mockResolvedValue([
      { orderItemId: "l1", qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 },
      { orderItemId: "l1", qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 },
    ]);
    poolRead();
    creditNoteItems();
    withReturn(2);
    await expect(service.processRefund("ret-1")).rejects.toMatchObject({
      response: { code: "RETURN_MIXED_UNIT_PRODUCT" },
    });
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });
});
