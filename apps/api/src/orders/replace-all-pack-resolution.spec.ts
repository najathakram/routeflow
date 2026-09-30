import { assertReplaceAllPackMatchesLive } from "./replace-all-pack-resolution";

describe("assertReplaceAllPackMatchesLive — SA-124g/h R1's ONE guard", () => {
  it("refuses when the item's own resolved pack (from unitsPerBox) disagrees with a known live pack", () => {
    expect(() =>
      assertReplaceAllPackMatchesLive(
        { productId: "p1", boxes: 1, pieces: 0, qty: 12, unitsPerBox: 12 },
        6,
      ),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: "MERGE_PACK_MISMATCH",
          productId: "p1",
          existingPacks: [12],
          incomingPack: 6,
        }),
      }),
    );
  });

  it("refuses when the item's own pack derived from its split (no explicit unitsPerBox) disagrees", () => {
    expect(() =>
      assertReplaceAllPackMatchesLive(
        { productId: "p1", boxes: 2, pieces: 0, qty: 24, unitsPerBox: null },
        6,
      ),
    ).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ existingPacks: [12] }) }),
    );
  });

  it("does not refuse when the own pack and the live pack agree", () => {
    expect(() =>
      assertReplaceAllPackMatchesLive(
        { productId: "p1", boxes: 1, pieces: 0, qty: 12, unitsPerBox: 12 },
        12,
      ),
    ).not.toThrow();
  });

  it("does not refuse when the item carries no resolvable pack of its own", () => {
    expect(() =>
      assertReplaceAllPackMatchesLive(
        { productId: "p1", boxes: null, pieces: null, qty: 5, unitsPerBox: null },
        6,
      ),
    ).not.toThrow();
  });

  it("refuses when the product has since been made UNBOXED (live pack unresolvable) but the item's own pack is known (Opus round-5 REQUIRED — was silently billing the stale box price per piece)", () => {
    expect(() =>
      assertReplaceAllPackMatchesLive(
        { productId: "p1", boxes: 1, pieces: 0, qty: 12, unitsPerBox: 12 },
        0,
      ),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: "MERGE_PACK_MISMATCH",
          existingPacks: [12],
          incomingPack: 0,
        }),
      }),
    );
  });

  it("still does not refuse when the item itself carries no resolvable pack, even against an unboxed live product", () => {
    expect(() =>
      assertReplaceAllPackMatchesLive(
        { productId: "p1", boxes: null, pieces: null, qty: 3, unitsPerBox: null },
        0,
      ),
    ).not.toThrow();
  });
});
