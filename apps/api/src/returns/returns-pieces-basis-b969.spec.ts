/**
 * B969 (SA-628p): a STANDARD return on a box-UNAWARE selling-unit line (order line `{ qty 2, boxes null, unitsPerBox 12 }` = 2
 * boxes; the invoice item in PIECES `{ qty 24, boxes 2, upb 12, subtotal 120 }`) was priced per PIECE but counted in BOXES:
 * `min(qty, Σ invItem.qty) × Σ subtotal / Σ invItem.qty` refunded 1 box as $5.00 instead of $60.00 (12x short).
 *
 * The fix prices in PIECES on BOTH sides with the existing converters (`standardReturnPieces` for the returned qty,
 * `piecesPerQtyOf` for each invoice item), and the preview (`findOne` / `findAll`) and the mint (`processRefund`) share them.
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
  unitsPerBox: 12,
  unitLabel: null,
  product: { unitsPerBox: 12 },
  ...over,
});
const invItem = (id: string, over: Record<string, unknown>) => ({
  id,
  productId: "pp",
  qty: 24,
  subtotal: 120,
  boxes: 2,
  pieces: 0,
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
// an invoice item that counts BOXES too (no split): the legacy selling-unit shape the 2-invoice pool path already handles
const BOX_UNAWARE_BOX = { qty: 1, subtotal: 120, boxes: null, pieces: null };
// the box-unaware order line's one linked live invoice item carries the split that proves the pack (factor 12)
const BOX_PROOF = [{ orderItemId: "l1", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }];

describe("ReturnsService — a STANDARD return is priced in PIECES on both sides (B969)", () => {
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

  const retRow = (invoices: any[], lineItems: any[], items: any[]) => ({
    id: "ret-1",
    returnNumber: "RET-1",
    status: "RECEIVED",
    kind: "STANDARD",
    customerId: "cust-1",
    items,
    order: { id: "ord-1", orderNumber: "ORD-1", invoices, lineItems },
  });
  const withReturn = (invoices: any[], lineItems: any[], items: any[]) => {
    prisma.return.findUnique.mockResolvedValue(retRow(invoices, lineItems, items));
    prisma.return.findMany.mockResolvedValue([retRow(invoices, lineItems, items)]);
    prisma.return.count.mockResolvedValue(1);
  };
  const mintedAmount = (): number => creditNotesCreate.mock.calls[0][0].amount;
  /** preview (findOne AND the findAll list row) and mint, for the same return: all must agree. */
  const previewAndMint = async () => {
    const one: any = await service.findOne("ret-1");
    const all: any = await service.findAll({ kind: "ALL" } as any);
    await service.processRefund("ret-1");
    return {
      findOne: one.refundEstimate,
      findAll: all.data[0].refundEstimate,
      mint: mintedAmount(),
    };
  };

  it("(a) RED REPRO: a box-unaware selling-unit line, 1 box of 2 => $60.00 in the preview AND the mint (was $5.00)", async () => {
    withReturn(
      [invoice("inv-1", [invItem("i1", {})])],
      [orderLine({})],
      [{ productId: "pp", qty: 1 }],
    );
    const r = await previewAndMint();
    expect(r.findOne).toBe(60);
    expect(r.findAll).toBe(60);
    expect(r.mint).toBe(60);
    // the credit note item stays on the invoice line's OWN axis (a box-split item counts pieces: 1 box = 12 pieces)
    expect(creditNotesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: "inv-1",
        items: [{ invoiceItemId: "i1", amount: 60, qty: 12 }],
      }),
      { ledgerReversedByReturn: true, returnId: "ret-1" },
    );
  });

  it("(a) a fractional box (0.5 of 2) prices in pieces too: 6 pieces => $30.00", async () => {
    withReturn(
      [invoice("inv-1", [invItem("i1", {})])],
      [orderLine({})],
      [{ productId: "pp", qty: 0.5 }],
    );
    const r = await previewAndMint();
    expect([r.findOne, r.findAll, r.mint]).toEqual([30, 30, 30]);
  });

  it("(a) the whole line (2 boxes) refunds the whole $120.00", async () => {
    withReturn(
      [invoice("inv-1", [invItem("i1", {})])],
      [orderLine({})],
      [{ productId: "pp", qty: 2 }],
    );
    const r = await previewAndMint();
    expect([r.findOne, r.findAll, r.mint]).toEqual([120, 120, 120]);
  });

  it("(b) a box-SPLIT line (qty already pieces) is unchanged: 12 of 24 pieces => $60.00", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    withReturn(
      [invoice("inv-1", [invItem("i1", {})])],
      [orderLine({ qty: 24, boxes: 2, pieces: 0 })],
      [{ productId: "pp", qty: 12 }],
    );
    const r = await previewAndMint();
    expect([r.findOne, r.findAll, r.mint]).toEqual([60, 60, 60]);
  });

  it("(c) a LOOSE (upb 1) product is unchanged: 6 of 12 => $30.00", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    withReturn(
      [
        invoice("inv-1", [
          invItem("i1", {
            qty: 12,
            subtotal: 60,
            boxes: null,
            pieces: null,
            unitsPerBox: 1,
            product: { unitsPerBox: 1 },
          }),
        ]),
      ],
      [
        orderLine({
          qty: 12,
          unitsPerBox: 1,
          product: { unitsPerBox: 1 },
          unitPrice: 5,
          subtotal: 60,
        }),
      ],
      [{ productId: "pp", qty: 6 }],
    );
    const r = await previewAndMint();
    expect([r.findOne, r.findAll, r.mint]).toEqual([30, 30, 30]);
  });

  it("(d) the 2-invoice POOL path is unchanged: two 1-box invoices, 1 box back => $120.00 lump on the latest, pooled in pieces", async () => {
    const invoices = [
      invoice("inv-1", [invItem("i1", BOX_UNAWARE_BOX)]),
      invoice("inv-2", [invItem("i2", BOX_UNAWARE_BOX)], {
        createdAt: new Date("2026-02-01"),
        total: 400, // room beyond the one line, so the lump's own invoice cap does not bind
      }),
    ];
    prisma.invoice.findMany.mockResolvedValue(invoices.map((i) => ({ id: i.id, items: i.items })));
    withReturn(invoices, [orderLine({})], [{ productId: "pp", qty: 1 }]);
    const r = await previewAndMint();
    expect([r.findOne, r.findAll, r.mint]).toEqual([120, 120, 120]);
    expect(creditNotesCreate.mock.calls[0][1]).toMatchObject({
      pooledRefund: [{ productId: "pp", qty: 12 }],
    });
  });

  it("(e) MIXED: 2 boxes of 12 + 12 loose pieces => 409 RETURN_MIXED_UNIT_PRODUCT at the mint, and the preview reports 0 WITH a reason", async () => {
    const loose = orderLine({
      id: "l2",
      qty: 12,
      boxes: 0,
      pieces: 12,
      position: 1,
      unitPrice: 5,
      subtotal: 60,
    });
    withReturn(
      [
        invoice("inv-1", [
          invItem("i1", {}),
          invItem("i2", { qty: 12, subtotal: 60, boxes: 0, pieces: 12 }),
        ]),
      ],
      [orderLine({}), loose],
      [{ productId: "pp", qty: 1 }],
    );
    const one: any = await service.findOne("ret-1");
    expect(one.refundEstimate).toBe(0);
    expect(one.refundEstimateReason).toBeTruthy();
    const err = await service.processRefund("ret-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "RETURN_MIXED_UNIT_PRODUCT" });
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  // review folds (PR #3004): the singleUnit legacy axis, the external refund door, and the 2+ invoice preview
  const mixedReturn = () => {
    const loose = orderLine({
      id: "l2",
      qty: 12,
      boxes: 0,
      pieces: 12,
      position: 1,
      unitPrice: 5,
      subtotal: 60,
    });
    withReturn(
      [
        invoice("inv-1", [
          invItem("i1", {}),
          invItem("i2", { qty: 12, subtotal: 60, boxes: 0, pieces: 12 }),
        ]),
      ],
      [orderLine({}), loose],
      [{ productId: "pp", qty: 1 }],
    );
  };

  it("F1: a legacy line (2 boxes, no split) billed on ONE invoice as two {qty 12, boxes 1} items has a SPLIT on the billed side: never priced raw ($5), refused in the mint and $0 WITH a reason in the preview", async () => {
    // two live invoice items for the one line: the pack is not provable (a line billed across several items parks)
    prisma.invoiceItem.findMany.mockResolvedValue([
      { orderItemId: "l1", qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 },
      { orderItemId: "l1", qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 },
    ]);
    withReturn(
      [
        invoice("inv-1", [
          invItem("i1", { qty: 12, subtotal: 60, boxes: 1 }),
          invItem("i2", { qty: 12, subtotal: 60, boxes: 1 }),
        ]),
      ],
      [orderLine({})],
      [{ productId: "pp", qty: 1 }],
    );
    const one: any = await service.findOne("ret-1");
    expect(one.refundEstimate).toBe(0);
    expect(one.refundEstimateReason).toBe("UNIT_UNRESOLVED");
    await expect(service.processRefund("ret-1")).rejects.toMatchObject({
      response: { code: "RETURN_MIXED_UNIT_PRODUCT" },
    });
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  it("F1: legacy billed items whose pieces-per-qty differ (one box-counted, one piece-split) are refused too", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    withReturn(
      [
        invoice("inv-1", [
          invItem("i1", { qty: 1, subtotal: 60, boxes: null, pieces: null }),
          invItem("i2", { qty: 12, subtotal: 60, boxes: 1, pieces: 0 }),
        ]),
      ],
      [orderLine({})],
      [{ productId: "pp", qty: 1 }],
    );
    const one: any = await service.findOne("ret-1");
    expect(one.refundEstimate).toBe(0);
    expect(one.refundEstimateReason).toBe("UNIT_UNRESOLVED");
  });

  it("F2: EXTERNAL_REFUND on a mixed-unit return is refused 409 RETURN_MIXED_UNIT_PRODUCT, never recorded as a silent $0 refund", async () => {
    mixedReturn();
    const err = await service
      .processRefund("ret-1", { method: "EXTERNAL_REFUND" } as any)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "RETURN_MIXED_UNIT_PRODUCT" });
    expect(err.getResponse().message).toMatch(/inline return|manually/);
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });

  it("F3: 2+ creditable invoices with NO pack evidence: the preview is $0 WITH a reason (the mint refuses), preview == mint", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([]); // no proof: the box-unaware line's pack is unknown
    const invoices = [
      invoice("inv-1", [invItem("i1", BOX_UNAWARE_BOX)]),
      invoice("inv-2", [invItem("i2", BOX_UNAWARE_BOX)], {
        createdAt: new Date("2026-02-01"),
        total: 400,
      }),
    ];
    prisma.invoice.findMany.mockResolvedValue(invoices.map((i) => ({ id: i.id, items: i.items })));
    withReturn(invoices, [orderLine({})], [{ productId: "pp", qty: 1 }]);
    const one: any = await service.findOne("ret-1");
    const all: any = await service.findAll({ kind: "ALL" } as any);
    expect(one.refundEstimate).toBe(0);
    expect(one.refundEstimateReason).toBe("UNIT_UNRESOLVED");
    expect(all.data[0].refundEstimate).toBe(0);
    expect(all.data[0].refundEstimateReason).toBe("UNIT_UNRESOLVED");
    await expect(service.processRefund("ret-1")).rejects.toMatchObject({
      response: { code: "RETURN_MIXED_UNIT_PRODUCT" },
    });
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });
});
