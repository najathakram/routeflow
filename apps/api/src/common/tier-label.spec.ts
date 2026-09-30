import { tierLabel } from "./tier-label";

describe("tierLabel", () => {
  it("returns the configured label when present", () => {
    expect(tierLabel({ "2": "Wholesaler" }, 2)).toBe("Wholesaler");
    expect(tierLabel({ "2": "Wholesaler" }, "2")).toBe("Wholesaler");
  });

  it("falls back to Tier N when no labels are configured", () => {
    expect(tierLabel(undefined, 1)).toBe("Tier 1");
    expect(tierLabel(null, 3)).toBe("Tier 3");
    expect(tierLabel({}, 4)).toBe("Tier 4");
  });

  it("falls back to Tier N when the configured labels don't cover that tier", () => {
    expect(tierLabel({ "2": "Wholesaler" }, 3)).toBe("Tier 3");
  });

  it("treats a blank or whitespace-only configured label as unset", () => {
    expect(tierLabel({ "2": "" }, 2)).toBe("Tier 2");
    expect(tierLabel({ "2": "   " }, 2)).toBe("Tier 2");
  });

  it("trims a configured label", () => {
    expect(tierLabel({ "2": "  Wholesaler  " }, 2)).toBe("Wholesaler");
  });

  it("handles null/undefined n without throwing, falling back to Tier ?", () => {
    expect(() => tierLabel({}, null)).not.toThrow();
    expect(() => tierLabel({}, undefined)).not.toThrow();
    expect(tierLabel({}, null)).toBe("Tier ?");
    expect(tierLabel({}, undefined)).toBe("Tier ?");
  });

  it("handles garbage n without throwing, falling back to Tier ?", () => {
    expect(tierLabel({}, "abc")).toBe("Tier ?");
    expect(tierLabel({}, NaN)).toBe("Tier ?");
    expect(tierLabel({}, -1)).toBe("Tier ?");
    expect(tierLabel({}, 0)).toBe("Tier ?");
    expect(tierLabel({}, "")).toBe("Tier ?");
  });

  it("accepts a numeric-string n", () => {
    expect(tierLabel({}, "5")).toBe("Tier 5");
  });

  it("matches a numeric n against a string-keyed label record", () => {
    expect(tierLabel({ "5": "VIP" }, 5)).toBe("VIP");
  });
});
