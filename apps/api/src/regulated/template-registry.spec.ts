import {
  REPORT_TEMPLATES,
  allColumnKeys,
  defaultColumnKeys,
  isValidItemType,
  isValidUom,
  itemTypeLabel,
  templateByKey,
} from "./template-registry";

describe("template-registry", () => {
  describe("isValidItemType", () => {
    it("accepts a known item type code for TX_COMPTROLLER", () => {
      expect(isValidItemType("TX_COMPTROLLER", "1")).toBe(true);
    });

    it("rejects an unknown item type code", () => {
      expect(isValidItemType("TX_COMPTROLLER", "9")).toBe(false);
    });

    it("rejects any item type for a template with no productConfig", () => {
      expect(isValidItemType("GENERIC", "1")).toBe(false);
    });
  });

  describe("isValidUom", () => {
    it("accepts a UoM that belongs to the given item type", () => {
      expect(isValidUom("TX_COMPTROLLER", "1", "CC")).toBe(true);
    });

    it("rejects a UoM that belongs to a different item type when itemType is specified", () => {
      // SB is a Cigars (code 2) UoM, not a Cigarettes (code 1) UoM.
      expect(isValidUom("TX_COMPTROLLER", "1", "SB")).toBe(false);
    });

    it("accepts a UoM when itemType is null, as long as SOME item type allows it", () => {
      expect(isValidUom("TX_COMPTROLLER", null, "SB")).toBe(true);
    });

    it("rejects a UoM that no item type allows, even with itemType null", () => {
      expect(isValidUom("TX_COMPTROLLER", null, "ZZ")).toBe(false);
    });

    it("rejects for a template with no productConfig", () => {
      expect(isValidUom("GENERIC", null, "CC")).toBe(false);
    });
  });

  describe("defaultColumnKeys", () => {
    it("excludes the three optional TX columns", () => {
      const keys = defaultColumnKeys("TX_COMPTROLLER");
      expect(keys).not.toContain("itemDescription");
      expect(keys).not.toContain("invoiceNumber");
      expect(keys).not.toContain("invoiceDate");
    });

    it("includes the twelve official TX columns in registry order", () => {
      const keys = defaultColumnKeys("TX_COMPTROLLER");
      expect(keys).toEqual([
        "wholesalerPermit",
        "retailerTaxpayerId",
        "retailerName",
        "retailerStreet",
        "retailerCity",
        "state",
        "zip",
        "retailerPermit",
        "itemType",
        "uom",
        "quantity",
        "invoiceAmount",
      ]);
    });

    it("returns an empty array for an unknown template", () => {
      expect(defaultColumnKeys("NOT_A_TEMPLATE")).toEqual([]);
    });
  });

  describe("allColumnKeys", () => {
    it("includes the optional TX columns in addition to the defaults", () => {
      const keys = allColumnKeys("TX_COMPTROLLER");
      expect(keys).toEqual(
        expect.arrayContaining(["itemDescription", "invoiceNumber", "invoiceDate"]),
      );
      expect(keys.length).toBe(15);
    });
  });

  describe("itemTypeLabel", () => {
    it("returns the label for a known item type", () => {
      expect(itemTypeLabel("TX_COMPTROLLER", "1")).toBe("Cigarettes");
    });

    it('returns "" for an unknown item type code', () => {
      expect(itemTypeLabel("TX_COMPTROLLER", "9")).toBe("");
    });

    it('returns "" when itemType is null', () => {
      expect(itemTypeLabel("TX_COMPTROLLER", null)).toBe("");
    });

    it('returns "" for a template with no productConfig', () => {
      expect(itemTypeLabel("GENERIC", "1")).toBe("");
    });
  });

  describe("templateByKey", () => {
    it("resolves a known template", () => {
      expect(templateByKey("TX_COMPTROLLER")?.label).toBe("TX Comptroller");
    });

    it("returns undefined for an unknown template", () => {
      expect(templateByKey("NOT_A_TEMPLATE")).toBeUndefined();
    });
  });

  describe("REPORT_TEMPLATES registry integrity", () => {
    it("every template's column keys are unique", () => {
      for (const t of REPORT_TEMPLATES) {
        const keys = t.columns.map((c) => c.key);
        expect(new Set(keys).size).toBe(keys.length);
      }
    });

    it("every template key in the registry is unique", () => {
      const keys = REPORT_TEMPLATES.map((t) => t.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("aggregate templates mirror filing-csv.ts buildAggregateReport's column keys", () => {
      expect(allColumnKeys("GENERIC")).toEqual([
        "period",
        "qty",
        "unitBasisQty",
        "netSales",
        "categoryTax",
      ]);
      expect(allColumnKeys("CA_CDTFA")).toEqual(["period", "units", "netSales", "tax"]);
      expect(allColumnKeys("CA_ABC")).toEqual(["period", "volume", "netSales", "tax"]);
      expect(allColumnKeys("CALRECYCLE")).toEqual(["period", "containers", "netSales", "deposit"]);
    });
  });
});
