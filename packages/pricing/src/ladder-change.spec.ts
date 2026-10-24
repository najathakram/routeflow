import { applyLadderChange, ladderChangeNote } from "./tier-pricing";

/**
 * P0 2026-10-14 (money): committing a tier price copied it into EVERY lower tier unconditionally, so raising Tier 3
 * 21.00 → 21.25 also set Tier 4 (19.50) and Tier 5 (18.00) to 21.25 with no message: tier 4/5 customers overcharged.
 * SA ruling (A amended), per lower tier independently, compared in cents (roundMoney):
 *  1. equal to the OLD value → the new value;
 *  2. 0 → stays 0 on a LIST change (N=1, it already follows the list); takes the new value on a Tier 2-4 change;
 *  3. non-zero and ABOVE the new value → capped to the new value;
 *  4. otherwise untouched.
 */
const ladder = (t2: unknown, t3: unknown, t4: unknown, t5: unknown) =>
  ({ priceTier2: t2, priceTier3: t3, priceTier4: t4, priceTier5: t5 }) as never;

describe("applyLadderChange", () => {
  it("REG: Tier 3 21.00 → 21.25 leaves Tier 4 (19.50) and Tier 5 (18.00) untouched", () => {
    expect(
      applyLadderChange("priceTier3", "21.00", "21.25", ladder("22.00", "21.00", "19.50", "18.00")),
    ).toEqual({});
  });

  it("REG: a fresh product (tiers 0) walks: T2 = 9 fills T3-T5, then T3 = 8 moves T4-T5", () => {
    expect(applyLadderChange("priceTier2", "0", "9", ladder("0", "0", "0", "0"))).toEqual({
      priceTier3: "9.00",
      priceTier4: "9.00",
      priceTier5: "9.00",
    });
    expect(applyLadderChange("priceTier3", "9", "8", ladder("9", "9", "9", "9"))).toEqual({
      priceTier4: "8.00",
      priceTier5: "8.00",
    });
  });

  it("an all-equal ladder moves together", () => {
    expect(applyLadderChange("priceTier2", "10", "11", ladder(10, 10, 10, 10))).toEqual({
      priceTier3: "11.00",
      priceTier4: "11.00",
      priceTier5: "11.00",
    });
  });

  it("the cap: T2 22 → 19 with T3 21, T4 20 caps both to 19; a cheaper T5 stays", () => {
    expect(applyLadderChange("priceTier2", "22", "19", ladder(22, 21, 20, 18))).toEqual({
      priceTier3: "19.00",
      priceTier4: "19.00",
    });
  });

  it("a LIST change keeps 0 tiers at 0 (they follow the list) and moves / caps the rest", () => {
    expect(applyLadderChange("pricePerUnit", "10", "12", ladder(9, 10, 0, 10))).toEqual({
      priceTier3: "12.00",
      priceTier5: "12.00",
    });
    expect(applyLadderChange("pricePerUnit", "10", "8", ladder(9, 10, 0, 10))).toEqual({
      priceTier2: "8.00",
      priceTier3: "8.00",
      priceTier5: "8.00",
    });
  });

  it("committing 0 (follow the list again) moves ONLY tiers equal to the old value, never caps", () => {
    expect(applyLadderChange("priceTier2", "9", "0", ladder(9, 9, 8, 0))).toEqual({
      priceTier3: "0.00",
    });
  });

  it("only LOWER tiers change; Tier 5 has none; unchanged / negative / non-numeric commits change nothing", () => {
    expect(
      Object.keys(applyLadderChange("priceTier4", "19.50", "17", ladder(22, 21, 19.5, 18))),
    ).toEqual(["priceTier5"]);
    expect(applyLadderChange("priceTier5", "18", "1", ladder(22, 21, 19.5, 18))).toEqual({});
    expect(applyLadderChange("priceTier2", "10", "10.00", ladder(10, 10, 10, 10))).toEqual({});
    expect(applyLadderChange("priceTier2", "10", -1, ladder(10, 10, 10, 10))).toEqual({});
    expect(applyLadderChange("priceTier2", "10", "abc", ladder(10, 10, 10, 10))).toEqual({});
  });

  it("rounds through roundMoney (REG-B122: 2.135 → 2.14, never 2.13)", () => {
    expect(applyLadderChange("priceTier2", "0", 2.135, ladder(0, 0, 0, 0))).toEqual({
      priceTier3: "2.14",
      priceTier4: "2.14",
      priceTier5: "2.14",
    });
  });
});

describe("ladderChangeNote: a tier commit that moves other tiers is never silent", () => {
  const label = (n: number) => `Tier ${n}`;
  it("names every moved tier and the price", () => {
    expect(ladderChangeNote({ priceTier4: "21.25", priceTier5: "21.25" }, label)).toBe(
      "Also set Tier 4 and Tier 5 to $21.25.",
    );
    expect(
      ladderChangeNote({ priceTier3: "9.00", priceTier4: "9.00", priceTier5: "9.00" }, label),
    ).toBe("Also set Tier 3, Tier 4 and Tier 5 to $9.00.");
    expect(ladderChangeNote({ priceTier5: "0.00" }, label)).toBe(
      "Also set Tier 5 to follow the list price.",
    );
  });
  it("is null when nothing moved", () => {
    expect(ladderChangeNote({}, label)).toBeNull();
  });
});
