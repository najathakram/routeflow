/**
 * PR-1a (Returns Inside Order Creation, schema + shared readers) — unit coverage for
 * returns-pieces.util.ts: the B4/m-6 fix (sold pieces = the SUM of a product's
 * non-CANCELLED lines, not the first `.find()` match) and the shared prior-returned
 * reader `returnedPiecesByProduct`, which must count BOTH kinds (STANDARD `Return`
 * rows and, once they exist, INLINE `ReturnItem` rows) regardless of which was
 * written first.
 */
import {
  firstNonCancelledLine,
  returnedPiecesByProduct,
  soldPiecesForProduct,
  standardReturnPieces,
} from "./returns-pieces.util";

describe("soldPiecesForProduct (B4/m-6)", () => {
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
    expect(soldPiecesForProduct(order, "p1")).toBe(15);
  });

  it("excludes CANCELLED lines from the sum", () => {
    const order = {
      lineItems: [
        { productId: "p1", qty: 10, status: "PENDING" },
        { productId: "p1", qty: 20, status: "CANCELLED" },
      ],
    };
    expect(soldPiecesForProduct(order, "p1")).toBe(10);
  });

  it("returns 0 for a product with no live line (the caller 400s on <= 0)", () => {
    const order = { lineItems: [{ productId: "p1", qty: 10, status: "CANCELLED" }] };
    expect(soldPiecesForProduct(order, "p1")).toBe(0);
    expect(soldPiecesForProduct(order, "p-never-ordered")).toBe(0);
  });

  it("box-split STANDARD DTO literal (§3.5): a 2bx+6pcs line (qty already 30 pieces) sums correctly", () => {
    const order = {
      lineItems: [
        { productId: "p1", qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12, status: "PENDING" },
      ],
    };
    expect(soldPiecesForProduct(order, "p1")).toBe(30);
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

describe("standardReturnPieces (m-6 conversion seam)", () => {
  it("is an identity conversion today — ReturnItem.qty is already pieces, like OrderItem.qty", () => {
    const order = {
      lineItems: [
        { productId: "p1", qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12, status: "PENDING" },
      ],
    };
    const { pieces, toLineUnit } = standardReturnPieces(order, "p1", 12);
    expect(pieces).toBe(12);
    expect(toLineUnit(12)).toBe(12);
    expect(toLineUnit(30)).toBe(30);
  });
});

describe("returnedPiecesByProduct (B4 shared reader, kind-aware)", () => {
  const fakeTx = (opts: { standardReturns?: any[]; inlineItems?: any[] }) => ({
    return: { findMany: jest.fn().mockResolvedValue(opts.standardReturns ?? []) },
    returnItem: { findMany: jest.fn().mockResolvedValue(opts.inlineItems ?? []) },
  });

  it("sums STANDARD Return rows alone when no INLINE rows exist (today's only case)", async () => {
    const tx = fakeTx({
      standardReturns: [{ items: [{ productId: "p1", qty: 6 }] }],
    });
    const result = await returnedPiecesByProduct(tx as any, "ord-1");
    expect(result).toEqual({ p1: 6 });
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
    expect(result).toEqual({ p1: 10 });
  });

  it("INLINE-after-STANDARD: order of seeding does not matter — both kinds always combine", async () => {
    const tx = fakeTx({
      standardReturns: [{ items: [{ productId: "p1", qty: 6 }] }],
      inlineItems: [{ productId: "p1", qty: 4 }],
    });
    const result = await returnedPiecesByProduct(tx as any, "ord-1");
    expect(result).toEqual({ p1: 10 });
  });

  it("combines across different products independently", async () => {
    const tx = fakeTx({
      standardReturns: [{ items: [{ productId: "p1", qty: 6 }] }],
      inlineItems: [{ productId: "p2", qty: 3 }],
    });
    const result = await returnedPiecesByProduct(tx as any, "ord-1");
    expect(result).toEqual({ p1: 6, p2: 3 });
  });
});
