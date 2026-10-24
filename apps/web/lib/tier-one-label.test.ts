import { tierOneLabel, productTierLabel, TIER_ONE_DEFAULT_LABEL } from "./tier-one-label";

describe("tierOneLabel (P02: one name for the base price)", () => {
  it("falls back to Retail, the app default, never 'Tier 1'", () => {
    expect(TIER_ONE_DEFAULT_LABEL).toBe("Retail");
    expect(tierOneLabel(undefined)).toBe("Retail");
    expect(tierOneLabel(null)).toBe("Retail");
    expect(tierOneLabel({})).toBe("Retail");
    expect(tierOneLabel({ "2": "Wholesale" })).toBe("Retail");
  });

  it("treats a blank configured label as unset", () => {
    expect(tierOneLabel({ "1": "   " })).toBe("Retail");
  });

  it("uses the tenant-configured label for tier 1", () => {
    expect(tierOneLabel({ "1": " Walk-in " })).toBe("Walk-in");
  });
});

describe("productTierLabel", () => {
  it("routes tier 1 through tierOneLabel and the rest through tierLabel", () => {
    expect(productTierLabel({}, 1)).toBe("Retail");
    expect(productTierLabel({}, "1")).toBe("Retail");
    expect(productTierLabel({ "1": "Walk-in" }, 1)).toBe("Walk-in");
    expect(productTierLabel({}, 2)).toBe("Tier 2");
    expect(productTierLabel({ "3": "Distributor" }, 3)).toBe("Distributor");
  });
});
