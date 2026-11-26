import { bookedTerms } from "./order-stock";

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
