/**
 * PR-1a (Returns Inside Order Creation, schema + shared readers) — unit coverage for
 * returns-pieces.util.ts: the B4/m-6 fix (sold pieces = the SUM of a product's
 * non-CANCELLED lines, not the first `.find()` match) and the shared prior-returned
 * reader `returnedPiecesByProduct`, which must count BOTH kinds (STANDARD `Return`
 * rows and, once they exist, INLINE `ReturnItem` rows) regardless of which was
 * written first.
 */
import { ConflictException } from "@nestjs/common";
import {
  firstNonCancelledLine,
  returnPricingAxis,
  returnedPiecesByProduct,
  soldQtyForProduct,
  standardPackBasesForOrders,
  standardReturnPieces,
} from "./returns-pieces.util";

describe("soldQtyForProduct (B4/m-6)", () => {
  it("sums qty across every non-CANCELLED line for the product — not just the first match", () => {
    const order = {
      lineItems: [
        { productId: "p1", qty: 10, status: "PENDING" },
        { productId: "p1", qty: 5, status: "CONFIRMED" },
        { productId: "p2", qty: 99, status: "PENDING" },
      ],
    };
    // Revert probe: the pre-fix `.find()` picked ONE line (10), undercounting the true
    // sold total of 15 across both live lines for p1.
    expect(soldQtyForProduct(order, "p1")).toBe(15);
  });

  it("counts a line in its OWN unit: a box-unaware boxed line of 6 boxes stays 6, never 72 pieces (B665)", () => {
    const order = { lineItems: [{ productId: "p1", qty: 6, status: "PENDING" }] };
    expect(soldQtyForProduct(order, "p1")).toBe(6);
  });

  it("excludes CANCELLED lines from the sum", () => {
    const order = {
      lineItems: [
        { productId: "p1", qty: 10, status: "PENDING" },
        { productId: "p1", qty: 20, status: "CANCELLED" },
      ],
    };
    expect(soldQtyForProduct(order, "p1")).toBe(10);
  });

  it("returns 0 for a product with no live line (the caller 400s on <= 0)", () => {
    const order = { lineItems: [{ productId: "p1", qty: 10, status: "CANCELLED" }] };
    expect(soldQtyForProduct(order, "p1")).toBe(0);
    expect(soldQtyForProduct(order, "p-never-ordered")).toBe(0);
  });

  it("box-split STANDARD DTO literal (§3.5): a 2bx+6pcs line (qty already 30 pieces) sums correctly", () => {
    const order = {
      lineItems: [
        { productId: "p1", qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12, status: "PENDING" },
      ],
    };
    expect(soldQtyForProduct(order, "p1")).toBe(30);
  });
});

describe("firstNonCancelledLine", () => {
  it("picks the lowest `position`, skipping CANCELLED lines", () => {
    const order = {
      lineItems: [
        { productId: "p1", qty: 5, status: "PENDING", position: 2 },
        { productId: "p1", qty: 99, status: "CANCELLED", position: 0 },
        { productId: "p1", qty: 10, status: "PENDING", position: 1 },
      ],
    };
    expect(firstNonCancelledLine(order, "p1")?.qty).toBe(10);
  });

  it("nulls sort last", () => {
    const order = {
      lineItems: [
        { productId: "p1", qty: 5, status: "PENDING", position: null },
        { productId: "p1", qty: 10, status: "PENDING", position: 0 },
      ],
    };
    expect(firstNonCancelledLine(order, "p1")?.qty).toBe(10);
  });
});

describe("standardReturnPieces (SA-158 conversion)", () => {
  it("a split line (factor 1): pieces = typed qty, round trip is the identity", () => {
    const bases = new Map([["p1", { factor: 1 }]]);
    const { pieces, toLineUnit } = standardReturnPieces(bases, "p1", 12);
    expect(pieces).toBe(12);
    expect(toLineUnit(30)).toBe(30);
  });

  it("a box-unaware 12-pack line: 3 boxes = 36 pieces and back", () => {
    const { pieces, toLineUnit } = standardReturnPieces(new Map([["p1", { factor: 12 }]]), "p1", 3);
    expect(pieces).toBe(36);
    expect(toLineUnit(36)).toBe(3);
  });

  it("toLineUnit rounds for messages: 31 pieces on a 12-pack reads 2.58, never 2.5833333333333335", () => {
    const { toLineUnit } = standardReturnPieces(new Map([["p1", { factor: 12 }]]), "p1", 1);
    expect(toLineUnit(31)).toBe(2.58);
  });

  it("refuses (409) an unknown basis, a mixed basis and a product with no basis", () => {
    const bases = new Map<string, any>([
      ["u", { unknown: true, reason: "no source" }],
      ["m", { mixed: true, factors: [1, 12] }],
    ]);
    expect(() => standardReturnPieces(bases, "u", 1)).toThrow(/basis unknown for product u/i);
    expect(() => standardReturnPieces(bases, "m", 1)).toThrow(/1 and 12 pieces per unit/);
    expect(() => standardReturnPieces(bases, "zz", 1)).toThrow(ConflictException);
  });
});

describe("returnedPiecesByProduct (B4 shared reader, kind-aware)", () => {
  const fakeTx = (opts: { standardReturns?: any[]; inlineItems?: any[] }) => ({
    return: { findMany: jest.fn().mockResolvedValue(opts.standardReturns ?? []) },
    returnItem: { findMany: jest.fn().mockResolvedValue(opts.inlineItems ?? []) },
    // SA-158: STANDARD items convert through the order's pack basis; these lines are all factor 1.
    orderItem: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          ["p1", "p2"].map((productId) => ({ id: `l-${productId}`, productId, qty: 10 })),
        ),
    },
    invoiceItem: { findMany: jest.fn().mockResolvedValue([]) },
  });

  it("sums STANDARD Return rows alone when no INLINE rows exist (today's only case)", async () => {
    const tx = fakeTx({
      standardReturns: [{ items: [{ productId: "p1", qty: 6 }] }],
    });
    const result = await returnedPiecesByProduct(tx as any, "ord-1");
    expect(result).toEqual({ p1: { pieces: 6 } });
    expect(tx.return.findMany).toHaveBeenCalledWith({
      where: { orderId: "ord-1", kind: "STANDARD", status: { notIn: ["REJECTED", "CANCELLED"] } },
      include: { items: { select: { productId: true, qty: true } } },
    });
    expect(tx.returnItem.findMany).toHaveBeenCalledWith({
      where: {
        sourceOrderId: "ord-1",
        return: { kind: "INLINE", status: { notIn: ["REJECTED", "CANCELLED"] } },
      },
      select: { productId: true, qty: true },
    });
  });

  it("STANDARD-after-INLINE: an INLINE row seeded first still contributes to the total", async () => {
    const tx = fakeTx({
      inlineItems: [{ productId: "p1", qty: 4 }],
      standardReturns: [{ items: [{ productId: "p1", qty: 6 }] }],
    });
    const result = await returnedPiecesByProduct(tx as any, "ord-1");
    // Revert probe: dropping the returnItem query (reverting to STANDARD-only) would
    // read 6 here instead of 10 — silently under-counting a customer's returns once an
    // INLINE capture exists on the same source order.
    expect(result).toEqual({ p1: { pieces: 10 } });
  });

  it("INLINE-after-STANDARD: order of seeding does not matter — both kinds always combine", async () => {
    const tx = fakeTx({
      standardReturns: [{ items: [{ productId: "p1", qty: 6 }] }],
      inlineItems: [{ productId: "p1", qty: 4 }],
    });
    const result = await returnedPiecesByProduct(tx as any, "ord-1");
    expect(result).toEqual({ p1: { pieces: 10 } });
  });

  it("combines across different products independently", async () => {
    const tx = fakeTx({
      standardReturns: [{ items: [{ productId: "p1", qty: 6 }] }],
      inlineItems: [{ productId: "p2", qty: 3 }],
    });
    const result = await returnedPiecesByProduct(tx as any, "ord-1");
    expect(result).toEqual({ p1: { pieces: 6 }, p2: { pieces: 3 } });
  });
});

describe("returnPricingAxis (B969): the ONE axis a STANDARD return is priced on", () => {
  const boxItem = { qty: 2, boxes: null, pieces: null, unitsPerBox: 12 }; // counts boxes
  const pieceItem = { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }; // counts pieces
  it("a known pack factor converts the returned qty to PIECES", () => {
    const bases = new Map([["p1", { factor: 12 }]]);
    expect(returnPricingAxis(bases, "p1", 1, [pieceItem])).toEqual({ pieces: true, returned: 12 });
  });
  it("an unknown pack on EVERY live line (singleUnit) keeps the legacy line-unit axis, raw qty", () => {
    const bases = new Map([["p1", { unknown: true as const, reason: "x", singleUnit: true }]]);
    expect(returnPricingAxis(bases, "p1", 1, [boxItem])).toEqual({ pieces: false, returned: 1 });
  });
  it("mixed, or unknown beside a resolvable line: no single axis", () => {
    const mixed = new Map([["p1", { mixed: true as const, factors: [1, 12] }]]);
    const unknown = new Map([["p1", { unknown: true as const, reason: "x", singleUnit: false }]]);
    expect(returnPricingAxis(mixed, "p1", 1, [pieceItem])).toEqual({ unresolved: true });
    expect(returnPricingAxis(unknown, "p1", 1, [pieceItem])).toEqual({ unresolved: true });
  });
  it("no live order line: the billed items' single factor, or unresolved when they differ", () => {
    expect(returnPricingAxis(new Map(), "p1", 1, [boxItem])).toEqual({
      pieces: true,
      returned: 12,
    });
    expect(returnPricingAxis(new Map(), "p1", 1, [boxItem, pieceItem])).toEqual({
      unresolved: true,
    });
  });
});

describe("standardPackBasesForOrders (B969): one invoice-item read for a whole page of orders", () => {
  const line = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    productId: "p1",
    qty: 2,
    status: "CONFIRMED",
    boxes: null,
    pieces: null,
    unitsPerBox: 12,
    unitLabel: null,
    product: { unitsPerBox: 12 },
    ...over,
  });
  it("reads the evidence for every ambiguous line of every order in ONE query", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { orderItemId: "a1", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 },
      { orderItemId: "b1", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 },
    ]);
    const tx = { invoiceItem: { findMany } };
    const out = await standardPackBasesForOrders(tx, [
      { id: "o1", lineItems: [line("a1")] },
      { id: "o2", lineItems: [line("b1")] },
      { id: "o1", lineItems: [line("a1")] }, // a second return on the same order costs nothing
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(out.get("o1")?.get("p1")).toEqual({ factor: 12 });
    expect(out.get("o2")?.get("p1")).toEqual({ factor: 12 });
  });
  it("a page with no ambiguous line (a split line) issues no query", async () => {
    const findMany = jest.fn();
    const out = await standardPackBasesForOrders({ invoiceItem: { findMany } }, [
      { id: "o1", lineItems: [line("a1", { boxes: 2, pieces: 0, qty: 24 })] },
    ]);
    expect(findMany).not.toHaveBeenCalled();
    expect(out.get("o1")?.get("p1")).toEqual({ factor: 1 });
  });
});
