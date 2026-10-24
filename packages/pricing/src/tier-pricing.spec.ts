import { applyLadderChange, getTierPrice } from "./tier-pricing";

/**
 * Locks the tier ladder semantics — this 17-line function is the whole tier
 * pricing engine, and it had ZERO coverage back when api, web and mobile each
 * kept their own copy and those copies diverged (missing `|| fallback` → $0.00
 * for DB-default-0 tier columns). There is now one implementation —
 * `@routeflow/pricing` — and this suite is the only thing locking it.
 */
describe("getTierPrice", () => {
  const product = {
    pricePerUnit: "10.00",
    priceTier2: "9.00",
    priceTier3: "8.50",
    priceTier4: "0", // DB default — tier never configured
    priceTier5: null as string | null, // legacy row — column null
  };

  it("returns the configured tier price", () => {
    expect(getTierPrice(product, 2)).toBe(9);
    expect(getTierPrice(product, 3)).toBe(8.5);
  });

  it("tier 1 is the list price", () => {
    expect(getTierPrice(product, 1)).toBe(10);
  });

  it("an unset tier (DB default 0) inherits the list price — the $0.00 regression", () => {
    expect(getTierPrice(product, 4)).toBe(10);
  });

  it("a null tier column inherits the list price", () => {
    expect(getTierPrice(product, 5)).toBe(10);
  });

  it("out-of-range tiers fall back to list", () => {
    expect(getTierPrice(product, 0)).toBe(10);
    expect(getTierPrice(product, 6)).toBe(10);
    expect(getTierPrice(product, NaN)).toBe(10);
  });

  it("coerces numeric and string decimals alike", () => {
    expect(getTierPrice({ pricePerUnit: 12.5, priceTier2: 11.25 }, 2)).toBe(11.25);
    expect(getTierPrice({ pricePerUnit: "12.50", priceTier2: "11.25" }, 2)).toBe(11.25);
  });

  it("a genuinely free product stays 0 (no fallback available)", () => {
    expect(getTierPrice({ pricePerUnit: "0", priceTier2: "0" }, 2)).toBe(0);
  });

  it("unparseable tier values fall back to list price", () => {
    expect(getTierPrice({ pricePerUnit: "10.00", priceTier2: "abc" }, 2)).toBe(10);
  });
});

describe("applyLadderChange (replaces the unconditional copy-down, P0 2026-10-14)", () => {
  const flat = (v: unknown) =>
    ({ priceTier2: v, priceTier3: v, priceTier4: v, priceTier5: v }) as never;

  it("copies the committed price into lower tiers that were TRACKING it (equal to the old value)", () => {
    expect(applyLadderChange("priceTier2", 10, 9, flat(10))).toEqual({
      priceTier3: "9.00",
      priceTier4: "9.00",
      priceTier5: "9.00",
    });
  });

  it("touches only the tiers below the edited one", () => {
    expect(applyLadderChange("priceTier4", 10, 8.5, flat(10))).toEqual({ priceTier5: "8.50" });
  });

  it("tier 5 has nothing below it", () => {
    expect(applyLadderChange("priceTier5", 10, 7, flat(10))).toEqual({});
  });

  it("rejects non-finite or negative input", () => {
    expect(applyLadderChange("priceTier2", 10, NaN, flat(10))).toEqual({});
    expect(applyLadderChange("priceTier2", 10, -1, flat(10))).toEqual({});
  });

  it("rounds half-up at the cent", () => {
    expect(applyLadderChange("priceTier2", 0, 9.005, flat(0))).toEqual({
      priceTier3: "9.01",
      priceTier4: "9.01",
      priceTier5: "9.01",
    });
  });

  it("committing 0 moves only the tracking tiers to 0.00 (they inherit the list again); a cheaper break stays", () => {
    expect(
      applyLadderChange("priceTier3", 9, 0, {
        priceTier2: 10,
        priceTier3: 9,
        priceTier4: 9,
        priceTier5: 7,
      } as never),
    ).toEqual({ priceTier4: "0.00" });
  });
});
