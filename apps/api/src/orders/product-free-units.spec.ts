import { PriceType } from "@prisma/client";
import { reallocateFreeUnits, type FreeUnitLine } from "./product-free-units";

/**
 * B297 row 355 (SA-734r2 r-note 6): the one home of a split product's BUY_N_GET_M free units — measured on
 * the combined whole units, allocated oldest line first, capped at each line's units.
 */
const BOGO = {
  id: "bogo",
  type: "BUY_N_GET_M" as const,
  value: 1,
  minQty: 5,
  scope: "ALL" as const,
};
const opts = { promos: [BOGO], canEarnNew: false, categoryFor: () => null };
const L = (
  key: string,
  qty: number,
  free: number,
  over: Partial<FreeUnitLine> = {},
): FreeUnitLine => ({
  key,
  productId: "p1",
  qty,
  boxes: null,
  pieces: null,
  pack: 0,
  unitPrice: 1,
  free,
  priceType: PriceType.STANDARD,
  originalPrice: null,
  overriddenBy: null,
  ...over,
});
const free = (changes: ReturnType<typeof reallocateFreeUnits>) =>
  Object.fromEntries(changes.map((c) => [c.key, c.free]));

describe("reallocateFreeUnits", () => {
  it("6 + 6 each carrying 1 free is 12 combined = 2 free, and the OLDEST line takes both", () => {
    const out = reallocateFreeUnits([L("old", 6, 1), L("new", 6, 1)], opts);
    expect(free(out)).toEqual({ old: 2, new: 0 });
    expect(out.find((c) => c.key === "old")!.subtotal).toBe(4); // 6 units, 2 free at $1.00
    expect(out.find((c) => c.key === "new")!.subtotal).toBe(6);
  });

  it("changes nothing when the allocation already matches (idempotent)", () => {
    expect(reallocateFreeUnits([L("a", 6, 2), L("b", 6, 0)], opts)).toEqual([]);
  });

  it("a shrunk sibling keeps the free unit the COMBINED quantity still earns", () => {
    // 1 + 11 = 12 earns 2; the per-line rescale left line "a" at 0 and "b" at 1 after the shrink.
    const out = reallocateFreeUnits([L("a", 1, 0), L("b", 11, 1)], opts);
    expect(free(out)).toEqual({ a: 1 }); // total 2 oldest first: a takes its 1 unit, b already holds the other
  });

  it("never gives units to a product that earned none when the edit cannot earn new", () => {
    expect(reallocateFreeUnits([L("a", 6, 0), L("b", 6, 0)], opts)).toEqual([]);
  });

  it("a buyer-driven merge may earn units no line had", () => {
    const out = reallocateFreeUnits([L("a", 7, 0), L("b", 5, 0)], { ...opts, canEarnNew: true });
    expect(free(out)).toEqual({ a: 2 });
  });

  it("leaves a product on ONE line, an operator price, a price promotion and empty promos untouched", () => {
    expect(reallocateFreeUnits([L("a", 12, 0)], { ...opts, canEarnNew: true })).toEqual([]);
    expect(
      reallocateFreeUnits([L("a", 6, 1, { priceType: PriceType.MANUAL }), L("b", 6, 1)], opts),
    ).toEqual([]);
    expect(
      reallocateFreeUnits(
        [L("a", 6, 1, { priceType: PriceType.PROMO, originalPrice: 2 }), L("b", 6, 1)],
        opts,
      ),
    ).toEqual([]);
    expect(reallocateFreeUnits([L("a", 6, 1), L("b", 6, 1)], { ...opts, promos: [] })).toEqual([]);
  });

  it("measures box-split and pack lines in real boxes (a pack line is qty x pack pieces)", () => {
    // pack line: 3 packs (qty 3, no split); box-split line: 36 pieces = 3 boxes; combined 6 boxes, N=5 M=1 => 1.
    const out = reallocateFreeUnits(
      [L("pack", 3, 0, { pack: 0 }), L("box", 36, 0, { boxes: 3, pieces: 0, pack: 12 })],
      { ...opts, canEarnNew: true },
    );
    expect(free(out)).toEqual({ pack: 1 });
    expect(out[0].subtotal).toBe(2); // 3 packs at $1.00 per box, 1 free
  });

  it("H-B: a unit-aware line (Piece) in the group excludes the product, whatever its pack snapshot", () => {
    const out = reallocateFreeUnits(
      [L("box", 4, 1, { pack: 12 }), L("piece", 5, 0, { unitLabel: "Piece", pack: 1 })],
      { ...opts, canEarnNew: true },
    );
    expect(out).toEqual([]);
  });

  it("a baseline re-measures with the PRE-edit units as the licence, even when one line is left", () => {
    // the edit short-picked the line that held the 2 free units; one line (6 units) remains
    const baseline = new Map([["p1", { free: 2, units: 12, lines: 2 }]]);
    const out = reallocateFreeUnits([L("b", 6, 0)], { ...opts, baseline });
    expect(free(out)).toEqual({ b: 1 });
  });

  it("without a baseline a lone line is never touched", () => {
    expect(reallocateFreeUnits([L("b", 6, 0)], opts)).toEqual([]);
  });
});
