/**
 * Units program S6 (PLAN §1.2, SA-795 (b)/(h)): the shared constants the schema slice ships.
 * Pins the packAuto bit order (Retail first, then tiers 2-5), the unit-ref keywords and the dark
 * settings defaults, so the later readers (priceSource, resolveUnitDefault, the settings writers)
 * import ONE definition. Constants only: nothing reads them yet, and every default is today.
 */
import {
  DEFAULT_INVOICE_UNIT,
  DEFAULT_ORDER_UNIT,
  DEFAULT_TIER_RULES,
  INVOICE_UNIT_BUSINESS_MODES,
  INVOICE_UNIT_SETTING_KEY,
  NEW_TENANT_INVOICE_UNIT,
  ORDER_UNIT_BUSINESS_MODES,
  ORDER_UNIT_SETTING_KEY,
  PACK_AUTO_ALL,
  PACK_AUTO_BITS,
  TIER_RULES_SETTING_KEY,
  UNIT_REF_BASE,
  UNIT_REF_KEYWORDS,
  UNIT_REF_PACK,
  isUnitRefKeyword,
} from "./units-prices-v2";

describe("Product.packAuto bit constants (SA-795 (b))", () => {
  it("are five bits, Retail first, then tiers 2-5 in column order", () => {
    expect(Object.keys(PACK_AUTO_BITS)).toEqual([
      "pricePerUnit",
      "priceTier2",
      "priceTier3",
      "priceTier4",
      "priceTier5",
    ]);
    expect(Object.values(PACK_AUTO_BITS)).toEqual([1, 2, 4, 8, 16]);
  });

  it("all bits together are 31, the CHECK's upper bound", () => {
    const or = Object.values(PACK_AUTO_BITS).reduce((a, b) => a | b, 0);
    expect(or).toBe(31);
    expect(PACK_AUTO_ALL).toBe(31);
  });
});

describe("unit refs", () => {
  it("the keywords are pack and base; anything else is a ProductUnit id", () => {
    expect(UNIT_REF_PACK).toBe("pack");
    expect(UNIT_REF_BASE).toBe("base");
    expect([...UNIT_REF_KEYWORDS]).toEqual(["pack", "base"]);
    expect(isUnitRefKeyword("pack")).toBe(true);
    expect(isUnitRefKeyword("base")).toBe(true);
    expect(isUnitRefKeyword("3f1c2e2a-0000-4000-8000-000000000000")).toBe(false);
    expect(isUnitRefKeyword("Pack")).toBe(false);
  });
});

describe("dark settings defaults (PLAN §1.2, M4; SA-795 (h): nothing turns on)", () => {
  it("pricing.tierRules defaults every tier 2-5 to 0% below Retail", () => {
    expect(TIER_RULES_SETTING_KEY).toBe("pricing.tierRules");
    expect(DEFAULT_TIER_RULES).toEqual({ 2: 0, 3: 0, 4: 0, 5: 0 });
    expect(Object.isFrozen(DEFAULT_TIER_RULES)).toBe(true);
  });

  it("units.orderUnit defaults to the pack (today's order unit on every product)", () => {
    expect(ORDER_UNIT_SETTING_KEY).toBe("units.orderUnit");
    expect(DEFAULT_ORDER_UNIT).toBe("pack");
    expect([...ORDER_UNIT_BUSINESS_MODES]).toEqual(["pack", "smallest"]);
  });

  it("units.invoiceUnit defaults to legacy (today's output); new tenants are meant to start on smallest", () => {
    expect(INVOICE_UNIT_SETTING_KEY).toBe("units.invoiceUnit");
    expect(DEFAULT_INVOICE_UNIT).toBe("legacy");
    expect(NEW_TENANT_INVOICE_UNIT).toBe("smallest");
    expect([...INVOICE_UNIT_BUSINESS_MODES]).toEqual(["legacy", "smallest", "ordered", "pack"]);
  });
});
