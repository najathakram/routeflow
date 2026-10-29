/**
 * SA-1042 B9b rule 7: a line item is credited at ITS line's price. The refund groups items by `returnGroupKey` =
 * (productId, sourceOrderItemId); a line group's invoice lines are the creditable invoice items billed from that order
 * line (`InvoiceItem.orderItemId`); pooled items keep the pooled average (SA-628b). One pricer: `planProductRefund`.
 *
 * Fixture: product P. Line A: 2 Cases of 200 (400 pcs, 90.00). Line B: 10 boxes of 10 (100 pcs, 25.00). Pooled average
 * 115.00 / 500 pieces = 0.23 a piece; line A is 90.00 / 400 = 0.225 a piece.
 */
import { Test } from "@nestjs/testing";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { returnGroupKey } from "./return-line-items";

const lineA = {
  id: "A",
  productId: "P",
  qty: 400,
  subtotal: 90,
  status: "CONFIRMED",
  boxes: 2,
  pieces: 0,
  unitsPerBox: 200,
  unitLabel: "Case",
};
const lineB = {
  id: "B",
  productId: "P",
  qty: 100,
  subtotal: 25,
  status: "CONFIRMED",
  boxes: 10,
  pieces: 0,
  unitsPerBox: 10,
};
const iiA = {
  id: "iA",
  orderItemId: "A",
  productId: "P",
  qty: 400,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 200,
  subtotal: 90,
};
const iiB = {
  id: "iB",
  orderItemId: "B",
  productId: "P",
  qty: 100,
  boxes: 10,
  pieces: 0,
  unitsPerBox: 10,
  subtotal: 25,
};
const inv = (id: string, items: any[], createdAt = "2026-01-01") => ({
  id,
  invoiceNumber: id.toUpperCase(),
  status: "SENT",
  total: items.reduce((t, i) => t + i.subtotal, 0),
  createdAt: new Date(createdAt),
  items,
});
const order = (invoices: any[]) => ({ id: "ord-1", invoices, lineItems: [lineA, lineB] });
const bases = new Map<string, any>([["P", { factor: 1 }]]);

let service: any;
beforeEach(async () => {
  const prisma = createMockPrisma();
  const mod = await Test.createTestingModule({
    providers: [
      ReturnsService,
      { provide: PrismaService, useValue: prisma },
      { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
      { provide: RegulatedLedgerService, useValue: {} },
      { provide: CreditNotesService, useValue: {} },
      { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
    ],
  }).compile();
  service = mod.get(ReturnsService);
});

const price = (items: any[], o: any) => service.priceReturn(items, o, bases);
const lineItem = (orderItemId: string, qty: number) => ({
  productId: "P",
  qty,
  sourceOrderItemId: orderItemId,
});

describe("returnGroupKey", () => {
  it("is the product for a pooled item and product + line for a line item", () => {
    expect(returnGroupKey({ productId: "P" })).toBe("P");
    expect(returnGroupKey({ productId: "P", sourceOrderItemId: null })).toBe("P");
    expect(returnGroupKey({ productId: "P", sourceOrderItemId: "A" })).not.toBe("P");
    expect(returnGroupKey({ productId: "P", sourceOrderItemId: "A" })).not.toBe(
      returnGroupKey({ productId: "P", sourceOrderItemId: "B" }),
    );
  });
});

describe("priceReturn: a line item is credited at its line's price (SA-1042 rule 7)", () => {
  const o = order([inv("inv-1", [iiA, iiB])]);

  it("R-r1: 200 pieces off line A credit 45.00, not the pooled 46.00", () => {
    expect(price([lineItem("A", 200)], o).amount).toBe(45);
  });
  it("G-r7 (pooled, KEPT): the same 200 pieces without a line key credit the pooled average, 46.00", () => {
    expect(price([{ productId: "P", qty: 200 }], o).amount).toBe(46);
  });
  it("line B is priced at B's own rate: 50 pieces credit 12.50", () => {
    expect(price([lineItem("B", 50)], o).amount).toBe(12.5);
  });
  it("G-r12: a never-invoiced order prices a line item from that order line's subtotal / qty (45.00), a pooled one pools (46.00)", () => {
    const noInvoice = order([]);
    expect(price([lineItem("A", 200)], noInvoice).amount).toBe(45);
    expect(price([{ productId: "P", qty: 200 }], noInvoice).amount).toBe(46);
  });
  it("G-r13: a line billed across two invoices pools that line's items only", () => {
    const a1 = {
      ...iiA,
      id: "iA1",
      qty: 300,
      boxes: undefined,
      pieces: undefined,
      unitsPerBox: undefined,
      subtotal: 67.5,
    };
    const a2 = {
      ...iiA,
      id: "iA2",
      qty: 100,
      boxes: undefined,
      pieces: undefined,
      unitsPerBox: undefined,
      subtotal: 22.5,
    };
    const split = order([inv("inv-1", [a1, iiB], "2026-01-01"), inv("inv-2", [a2], "2026-01-02")]);
    const split1 = price([lineItem("A", 200)], split);
    expect(split1.amount).toBe(45);
    expect(split1.invoiceId).toBe("inv-2"); // the latest of 2+, as today
  });
  it("a line never billed on a creditable invoice is NOTHING_BILLED for that group (amount 0, a reason)", () => {
    const onlyA = order([inv("inv-1", [iiA])]);
    const r = price([lineItem("B", 50)], onlyA);
    expect(r).toMatchObject({ amount: 0, refusal: "NOTHING_BILLED" });
  });
});

describe("itemiseRefund: the credit note item lands on the line's own invoice item (SA-1042 rule 7)", () => {
  const db = {
    creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
    creditNote: {
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
    },
  };
  const invoice = inv("inv-1", [iiA, iiB]);

  it("R-r1: 200 pieces off A is one item on A's invoice item, 45.00", async () => {
    const items = await service.itemiseRefund([lineItem("A", 200)], invoice, bases, db);
    expect(items.map((i: any) => [i.invoiceItemId, i.amount])).toEqual([["iA", 45]]);
  });
  it("G-r7 (pooled, KEPT): the pooled 200 fills lines in line order, 46.00 in all", async () => {
    const items = await service.itemiseRefund([{ productId: "P", qty: 200 }], invoice, bases, db);
    expect(items.reduce((t: number, i: any) => t + i.amount, 0)).toBeCloseTo(46, 2);
  });
  it("G-r17: line A's own headroom is the cap: 1 Case off a line with only 40.00 left refuses RETURN_REFUND_OVER_LINE_HEADROOM", async () => {
    db.creditNoteItem.findMany.mockResolvedValueOnce([
      { invoiceItemId: "iA", amount: 50, qty: 222.222 },
    ]);
    const err = await service
      .itemiseRefund([lineItem("A", 200)], invoice, bases, db)
      .catch((e: any) => e);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.RETURN_REFUND_OVER_LINE_HEADROOM,
    });
  });
});
