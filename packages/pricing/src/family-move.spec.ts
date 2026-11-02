import { familyCellsFor, familyMoveOf, resolveFamilyCellEdits } from "./family-move";
import { getTierPrice } from "./tier-pricing";

const row = (retail: number, t2 = 0, pack = 12, extra: object = {}) => ({
  pricePerUnit: retail,
  priceTier2: t2,
  priceTier3: 0,
  priceTier4: 0,
  priceTier5: 0,
  unitsPerBox: pack,
  ...extra,
});

describe("familyMoveOf (SA-1082 A-1, VM-1, VM-3)", () => {
  it("moves a variant at the family's Retail, and only that", () => {
    const before = row(24);
    const after = row(26);
    expect(familyMoveOf(before, after, row(24))?.columns).toEqual({ pricePerUnit: 26 });
    expect(familyMoveOf(before, after, row(30))).toBeNull();
  });

  it("scales by pieces when the packs differ, rounded once", () => {
    const before = row(24, 22);
    const after = row(26, 22);
    const six = row(12, 11, 6);
    expect(familyMoveOf(before, after, six)?.columns).toEqual({ pricePerUnit: 13 });
    expect(familyMoveOf(before, after, row(24, 0, 6))).toBeNull();
    // 25.01 x 5 / 12 = 10.42083..., one round, never a round of a rounded per-piece price.
    expect(familyMoveOf(row(24), row(25.01), row(10, 0, 5))?.columns).toEqual({
      pricePerUnit: 10.42,
    });
  });

  it("VM-3b (A-2): a family with no pack moves the number as it is, never scaled", () => {
    for (const noPack of [null, 0, 1]) {
      const before = row(24, 0, noPack as number);
      const after = row(26, 0, noPack as number);
      const twelve = row(24, 0, 12);
      expect(familyCellsFor(before, twelve)?.[0]).toEqual({ value: 24, follows: true });
      expect(familyMoveOf(before, after, twelve)).toMatchObject({
        columns: { pricePerUnit: 26 },
        from: 24,
        to: 26,
      });
    }
  });

  it("VM-12 (A-3): a family with blank tiers, a variant with tiers stored at 24: every tier ends up billing 26", () => {
    const stored = row(24, 24, 12, { priceTier3: 24, priceTier4: 24, priceTier5: 24 });
    const move = familyMoveOf(row(24), row(26), stored);
    expect(move?.columns).toEqual({
      pricePerUnit: 26,
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
    });
    const billed = { ...stored, ...move?.columns };
    expect([1, 2, 3, 4, 5].map((t) => getTierPrice(billed, t))).toEqual([26, 26, 26, 26, 26]);
  });

  it("a variant with no pack has no pieces to scale by: the family's number as it is", () => {
    const blank = row(24, 0, null as unknown as number);
    expect(familyCellsFor(row(24), blank)?.[0]).toEqual({ value: 24, follows: true });
    expect(familyMoveOf(row(24), row(26), blank)?.columns).toEqual({ pricePerUnit: 26 });
  });

  it("moves a tier only when Retail and that tier both match", () => {
    const before = row(24, 22);
    const after = row(26, 23);
    expect(familyMoveOf(before, after, row(24, 22))?.columns).toEqual({
      pricePerUnit: 26,
      priceTier2: 23,
    });
    // VM-7: own Retail 30 with a tier copied at 22 stays put.
    expect(familyMoveOf(before, after, row(30, 22))).toBeNull();
    // Retail matches, this tier was typed apart: Retail moves, the tier stays.
    expect(familyMoveOf(before, after, row(24, 20))?.columns).toEqual({ pricePerUnit: 26 });
  });

  it("keeps a blank tier blank, and a blank family tier blanks a follower", () => {
    expect(familyMoveOf(row(24), row(26), row(24))?.columns).toEqual({ pricePerUnit: 26 });
    expect(familyMoveOf(row(24, 22), row(24), row(24, 22))?.columns).toEqual({ priceTier2: null });
    // A blank variant tier against a family tier of 22 bills 24, so it doesn't follow that tier.
    expect(familyMoveOf(row(24, 22), row(26, 23), row(24))?.columns).toEqual({ pricePerUnit: 26 });
    // The family's tier now equals the new Retail: a blank tier already bills it, so nothing is stamped.
    expect(familyMoveOf(row(24), row(26, 26), row(24))?.columns).toEqual({ pricePerUnit: 26 });
  });

  it("compares effective values, so a tier stored as a copy of Retail matches a blank one", () => {
    expect(familyMoveOf(row(24), row(26), row(24, 24))?.columns).toEqual({
      pricePerUnit: 26,
      priceTier2: null,
    });
  });

  it("never lists an own order unit, a $0 family, or a save that moves nothing", () => {
    expect(familyMoveOf(row(24), row(26), row(24, 0, 12, { ownOrderUnit: true }))).toBeNull();
    expect(familyMoveOf(row(0), row(26), row(0))).toBeNull();
    expect(familyMoveOf(row(24), row(0), row(24))).toBeNull();
    expect(familyMoveOf(row(24, 22), row(24, 22), row(24, 22))).toBeNull();
  });

  it("clears a tier's Auto bit when it takes a number, and reports Retail from and to", () => {
    const move = familyMoveOf(row(24, 22), row(26, 23), row(24, 22, 12, { packAuto: 2 + 4 }));
    expect(move?.packAuto).toBe(4);
    expect(move?.from).toBe(24);
    expect(move?.to).toBe(26);
  });
});

describe("familyCellsFor (ruling 1's table)", () => {
  it("gives each blank box's number, and says which cells are at the family's price", () => {
    const cells = familyCellsFor(row(24, 22), row(12, 11, 6));
    expect(cells?.[0]).toEqual({ value: 12, follows: true });
    expect(cells?.[1]).toEqual({ value: 11, follows: true });
    // A blank family tier has no number to give; the blank variant tier bills the same, so it follows.
    expect(cells?.[2]).toEqual({ value: null, follows: true });
  });

  it("a tier under an own Retail doesn't follow, even when it equals the family's", () => {
    const cells = familyCellsFor(row(24, 22), row(30, 22));
    expect(cells?.[0]?.follows).toBe(false);
    expect(cells?.[1]).toEqual({ value: 22, follows: false });
  });

  it("no usable family Retail gives no number and nothing follows; an order unit isn't in this at all", () => {
    const cells = familyCellsFor(row(0), row(0));
    expect(cells?.[0]).toEqual({ value: null, follows: false });
    expect(familyCellsFor(row(24), row(24, 0, 12, { ownOrderUnit: true }))).toBeNull();
  });
});

describe("resolveFamilyCellEdits (rulings 6 and 7, VM-4, VM-6)", () => {
  const atFamily = familyCellsFor(row(24, 22), row(24, 22)) ?? [];
  const ownRetail = familyCellsFor(row(24, 22), row(30, 22)) ?? [];

  it("a cleared Retail takes the family's number", () => {
    expect(resolveFamilyCellEdits(ownRetail, [{ tier: 1, to: null }])).toEqual([
      { tier: 1, to: 24 },
    ]);
  });

  it("a cleared tier takes the family's number while Retail follows, and stays blank under an own Retail", () => {
    const set = familyCellsFor(row(24, 22), row(24, 20)) ?? [];
    expect(resolveFamilyCellEdits(set, [{ tier: 2, to: null }])).toEqual([{ tier: 2, to: 22 }]);
    expect(resolveFamilyCellEdits(ownRetail, [{ tier: 2, to: null }])).toEqual([
      { tier: 2, to: null },
    ]);
  });

  it("Use family prices: all five blank boxes come back as the family's", () => {
    const edits = [1, 2, 3, 4, 5].map((tier) => ({ tier, to: null }));
    expect(resolveFamilyCellEdits(ownRetail, edits)).toEqual([
      { tier: 1, to: 24 },
      { tier: 2, to: 22 },
      { tier: 3, to: null },
      { tier: 4, to: null },
      { tier: 5, to: null },
    ]);
  });

  it("a Retail typed away from the family's blanks the tiers still at its value, unless typed too", () => {
    expect(resolveFamilyCellEdits(atFamily, [{ tier: 1, to: 30 }])).toEqual([
      { tier: 1, to: 30 },
      { tier: 2, to: null },
      { tier: 3, to: null },
      { tier: 4, to: null },
      { tier: 5, to: null },
    ]);
    expect(
      resolveFamilyCellEdits(atFamily, [
        { tier: 1, to: 30 },
        { tier: 2, to: 28 },
      ]),
    ).toEqual([
      { tier: 1, to: 30 },
      { tier: 2, to: 28 },
      { tier: 3, to: null },
      { tier: 4, to: null },
      { tier: 5, to: null },
    ]);
  });

  it("a Retail typed equal to the family's leaves the tiers alone", () => {
    expect(resolveFamilyCellEdits(atFamily, [{ tier: 1, to: 24 }])).toEqual([{ tier: 1, to: 24 }]);
  });

  it("a blank Retail with no usable family Retail stays blank, for the ladder to refuse", () => {
    const none = familyCellsFor(row(0), row(30)) ?? [];
    expect(resolveFamilyCellEdits(none, [{ tier: 1, to: null }])).toEqual([{ tier: 1, to: null }]);
  });
});
