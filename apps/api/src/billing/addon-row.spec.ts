import { addonCodeOf, addonRowMatches, addonRowWhere, legacyKeysFor } from "./addon-row";
import { LEGACY_ADDON_KEY_TO_SKU } from "./plan-catalog.constants";

// #2188 / SA-385 (1): ONE predicate, legacy keys derived from the inverse of the ONE map.
describe("addon-row — the shared add-on lookup (SA-385)", () => {
  it("derives every legacy key from LEGACY_ADDON_KEY_TO_SKU's inverse, never a second map", () => {
    for (const [key, sku] of Object.entries(LEGACY_ADDON_KEY_TO_SKU)) {
      expect(legacyKeysFor(sku)).toContain(key);
      expect(addonCodeOf(key)).toBe(sku);
    }
    expect(legacyKeysFor("CUSTOMER_PACK_100")).toEqual([]);
    expect(addonCodeOf("developer_mode")).toBe("developer_mode"); // unbridged keys are themselves
  });

  it("matches a row by addonKey = sku, by sku, or by one of sku's legacy keys", () => {
    expect(addonRowWhere("t1", "REGULATED_ITEMS")).toEqual({
      tenantId: "t1",
      OR: [
        { addonKey: "REGULATED_ITEMS" },
        { sku: "REGULATED_ITEMS" },
        { addonKey: { in: ["tobacco_dealer"] } },
      ],
    });
    expect(addonRowWhere("t1", "FORECASTING").OR).toHaveLength(2); // no legacy clause
  });

  it("finds a legacy-keyed row by its SKU even when the row's sku column is null", () => {
    expect(addonRowMatches({ addonKey: "tobacco_dealer", sku: null }, "REGULATED_ITEMS")).toBe(
      true,
    );
    expect(addonRowMatches({ addonKey: "MSRP", sku: "MSRP" }, "MSRP")).toBe(true);
    expect(addonRowMatches({ addonKey: "msrp", sku: "MSRP" }, "MSRP")).toBe(true);
    expect(addonRowMatches({ addonKey: "ocr", sku: null }, "MSRP")).toBe(false);
  });
});
