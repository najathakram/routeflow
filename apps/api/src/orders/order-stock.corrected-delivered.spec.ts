import { bookedPieces, bookedTerms, settleStockForEdit, type OrderStockDeps } from "./order-stock";

/**
 * SA-1506 PR-1a (A1 B2): `bookedTerms` books max(qty, delivered) per line. A correction that lowers the delivered column
 * passes the restated figure in `corrected`, so the after-term reads it instead of the held d. Without the map the
 * after-term still reads the held d (the revert probe: the goods the admin says never left would stay booked).
 */
const held = [{ id: "L1", qty: 10, deliveredQty: 10 }];
const final8 = [{ id: "L1", qty: 8, deliveredQty: 10 }];

describe("bookedTerms: correctedDelivered (SA-1506 B2)", () => {
  it("revert probe: without the map the matched after-term still books the held delivered 10", () => {
    const terms = bookedTerms(held as any, final8 as any);
    const after = terms.find((t) => t.bucket === "matched" && t.side === "after");
    expect(after?.b?.perPack).toBe(10);
  });

  it("with the map the matched after-term books the corrected delivered 8 (the 2 come back)", () => {
    const terms = bookedTerms(held as any, final8 as any, "stable", new Map([["L1", 8]]));
    const after = terms.find((t) => t.bucket === "matched" && t.side === "after");
    expect(after?.a.perPack).toBe(8);
    expect(after?.b?.perPack).toBe(8);
    const before = terms.find((t) => t.bucket === "matched" && t.side === "before");
    expect(before?.b?.perPack).toBe(10); // the before-terms keep the held d
  });

  it("a take-off (the line is struck, no final line) books the corrected 0, so all 10 come back", () => {
    const terms = bookedTerms(held as any, [], "stable", new Map([["L1", 0]]));
    const after = terms.find((t) => t.bucket === "unmatched" && t.side === "after");
    expect(after?.a.perPack).toBe(0);
  });

  it("a take-off without the map keeps the delivered 10 booked (the pre-SA-1506 rule)", () => {
    const terms = bookedTerms(held as any, [], "stable");
    const after = terms.find((t) => t.bucket === "unmatched" && t.side === "after");
    expect(after?.a.perPack).toBe(10);
  });

  it("a line the map does not name is unchanged", () => {
    const terms = bookedTerms(held as any, final8 as any, "stable", new Map([["other", 1]]));
    const after = terms.find((t) => t.bucket === "matched" && t.side === "after");
    expect(after?.b?.perPack).toBe(10);
  });
});

describe("bookedPieces with the map: the ONE booking rule (SA-1533 (t), (w))", () => {
  it("a cancelled line the map does not name stays booked: 10 before, 10 after, nothing comes back", () => {
    const out = bookedPieces(held as any, [], undefined, "stable", new Map([["other", 0]]));
    expect(out.before).toBe(10);
    expect(out.after).toBe(10);
  });

  it("a cancelled line the map names as 0 books 0 after: all 10 come back", () => {
    const out = bookedPieces(held as any, [], undefined, "stable", new Map([["L1", 0]]));
    expect(out.before - out.after).toBe(10);
  });

  it("a cut to 8 with the map at 8 frees 2; without the map it frees nothing (the audit row reads this same number)", () => {
    const withMap = bookedPieces(
      held as any,
      final8 as any,
      undefined,
      "stable",
      new Map([["L1", 8]]),
    );
    expect(withMap.before - withMap.after).toBe(2);
    const noMap = bookedPieces(held as any, final8 as any);
    expect(noMap.before - noMap.after).toBe(0);
  });

  it("a raise to 14 on a line delivered 10 books the new 14: stock down 2 more, map or not", () => {
    const final14 = [{ id: "L1", qty: 14, deliveredQty: 10 }];
    const out = bookedPieces(
      held as any,
      final14 as any,
      undefined,
      "stable",
      new Map([["L1", 10]]),
    );
    expect(out.before - out.after).toBe(-4);
  });
});

describe("settleStockForEdit: correctedDelivered needs the stable identity (SA-1531 M-1)", () => {
  const deps: OrderStockDeps = { logger: { warn: jest.fn() }, tenantId: "t-1" };
  const tx = { product: { findMany: jest.fn() } } as any;

  it("throws, before any read, when the map arrives with lineIdentity recreated", async () => {
    await expect(
      settleStockForEdit(
        deps,
        tx,
        { id: "o-1", status: "CONFIRMED" } as any,
        held as any,
        [{ id: "L1", productId: "p1", qty: 8 }] as any,
        undefined,
        undefined,
        { lineIdentity: "recreated", correctedDelivered: new Map([["L1", 8]]) },
      ),
    ).rejects.toThrow(/stable line identity/);
    expect(tx.product.findMany).not.toHaveBeenCalled();
  });
});
