/**
 * B858 + B859 — pure pins for the column-registry module `import-columns.ts` (FIX1,
 * cause-ruling.md §2.A / SA-284). This module does not exist on this tree yet — these pins are
 * EXPECTED to fail to compile until FIX1 lands `./import-columns`. They are deliberately kept out
 * of `import-commercial-columns.spec.ts` (which must compile against today's `ImportService`) per
 * bug-test-plan.md: "Put pins needing new modules in import-columns.spec.ts (expected to error
 * until FIX1)".
 *
 * No Nest, no Prisma — `normalizeHeader` / the two column registries / cell parsers /
 * `resolveColumns` are all pure functions (cause-ruling.md §2.A).
 */
import {
  normalizeHeader,
  PRODUCT_COLUMNS,
  CUSTOMER_COLUMNS,
  resolveColumns,
} from "./import-columns";

describe("import-columns (FIX1 pins)", () => {
  // ── P1: alias table resolves to canonical fields ────────────────────────────
  describe("P1: alias resolution", () => {
    const productAliasCases: Array<[string, string]> = [
      ["Item Name", "name"],
      ["Name", "name"],
      ["Product Name", "name"],
      ["SKU", "sku"],
      ["Item Code", "sku"],
      ["Barcode", "barcode"],
      ["UPC", "barcode"],
      ["EAN", "barcode"],
      ["Unit", "unit"],
      ["Usage Unit", "unit"],
      ["UOM", "unit"],
      ["Rate", "pricePerUnit"],
      ["Sales Rate", "pricePerUnit"],
      ["Price", "pricePerUnit"],
      ["Sales Price", "pricePerUnit"],
      ["Selling Price", "pricePerUnit"],
      ["Price Tier 2", "priceTier2"],
      ["Tier 2 Price", "priceTier2"],
      ["Units Per Box", "unitsPerBox"],
      ["Pack Size", "unitsPerBox"],
      ["Case Qty", "unitsPerBox"],
      ["Units/Box", "unitsPerBox"],
      ["Category", "category"],
      ["Item Category", "category"],
      ["Cost", "standardCost"],
      ["Purchase Rate", "standardCost"],
      ["Standard Cost", "standardCost"],
      ["Purchase Price", "standardCost"],
      ["MSRP", "msrp"],
      ["Retail Price", "msrp"],
      ["Tobacco", "isTobacco"],
      ["Is Tobacco", "isTobacco"],
      ["Reorder Point", "reorderPoint"],
      ["Reorder Level", "reorderPoint"],
    ];

    it.each(productAliasCases)(
      'PRODUCT_COLUMNS: header "%s" resolves to field "%s"',
      (header, field) => {
        const { byField } = resolveColumns([header], PRODUCT_COLUMNS);
        expect(byField[field]).toBe(header);
      },
    );

    const customerAliasCases: Array<[string, string]> = [
      ["Customer Name", "businessName"],
      ["Display Name", "businessName"],
      ["Company Name", "businessName"],
      ["Customer ID", "zohoContactId"],
      ["Contact ID", "zohoContactId"],
      ["Payment Terms", "defaultPaymentTerms"],
      ["Terms", "defaultPaymentTerms"],
      ["Pricing Tier", "pricingTier"],
      ["Price Tier", "pricingTier"],
      ["Tier", "pricingTier"],
      ["Credit Limit", "creditLimit"],
      ["Tax Exempt", "isTaxExempt"],
      ["Tax ID", "taxId"],
      ["Tax Number", "taxId"],
      ["EIN", "taxId"],
      ["Tobacco Licence No", "tobaccoLicenseNo"],
      ["Tobacco License No", "tobaccoLicenseNo"],
      ["Tobacco Licence Expiry", "tobaccoLicenseExpiry"],
      ["Tobacco License Expiry", "tobaccoLicenseExpiry"],
      ["Delivery Window Start", "deliveryWindowStart"],
      ["Delivery Window End", "deliveryWindowEnd"],
      ["SMS Consent", "smsConsent"],
      ["WhatsApp Consent", "waConsent"],
    ];

    it.each(customerAliasCases)(
      'CUSTOMER_COLUMNS: header "%s" resolves to field "%s"',
      (header, field) => {
        const { byField } = resolveColumns([header], CUSTOMER_COLUMNS);
        expect(byField[field]).toBe(header);
      },
    );
  });

  // ── P2: one bad-cell case per parser kind ───────────────────────────────────
  describe("P2: bad-cell cases per parser kind", () => {
    it("money: a non-numeric non-blank cell is bad", () => {
      const col = PRODUCT_COLUMNS.find((c) => c.field === "pricePerUnit")!;
      const r = col.parse("12abc");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not a number/);
    });

    it("int: an out-of-range cell is bad", () => {
      const col = PRODUCT_COLUMNS.find((c) => c.field === "reorderPoint")!;
      const r = col.parse("-5");
      expect(r.ok).toBe(false);
    });

    it("bool: an unrecognized literal is bad", () => {
      const col = PRODUCT_COLUMNS.find((c) => c.field === "isTobacco")!;
      const r = col.parse("maybe");
      expect(r.ok).toBe(false);
    });

    it("terms: an unknown label is bad", () => {
      const col = CUSTOMER_COLUMNS.find((c) => c.field === "defaultPaymentTerms")!;
      const r = col.parse("Whenever works");
      expect(r.ok).toBe(false);
    });

    it("tier: out of 1-5 is bad", () => {
      const col = CUSTOMER_COLUMNS.find((c) => c.field === "pricingTier")!;
      const r = col.parse("9");
      expect(r.ok).toBe(false);
    });

    it("date: an unparseable cell is bad", () => {
      const col = CUSTOMER_COLUMNS.find((c) => c.field === "tobaccoLicenseExpiry")!;
      const r = col.parse("not-a-date");
      expect(r.ok).toBe(false);
    });
  });

  // ── P3: blank cell never clears ──────────────────────────────────────────────
  describe("P3: blank cell => {ok:true, value:undefined} for every registered field", () => {
    it.each(PRODUCT_COLUMNS.map((c) => [c.field, c] as const))(
      "PRODUCT_COLUMNS.%s",
      (_field, col) => {
        expect(col.parse("")).toEqual({ ok: true, value: undefined });
      },
    );

    it.each(CUSTOMER_COLUMNS.map((c) => [c.field, c] as const))(
      "CUSTOMER_COLUMNS.%s",
      (_field, col) => {
        expect(col.parse("")).toEqual({ ok: true, value: undefined });
      },
    );
  });

  // ── P4: no averageCost field ──────────────────────────────────────────────
  it("P4: PRODUCT_COLUMNS has no averageCost field", () => {
    expect(PRODUCT_COLUMNS.some((c) => c.field === "averageCost")).toBe(false);
  });

  // ── P5: "Average Cost" resolves to nothing, surfaces as unknown ────────────
  it('P5: header "Average Cost" resolves to nothing and is reported in unknownColumns', () => {
    const { byField, unknownColumns } = resolveColumns(["Average Cost"], PRODUCT_COLUMNS);
    expect(Object.values(byField)).not.toContain("Average Cost");
    expect(unknownColumns).toContain("Average Cost");
  });

  // ── normalizeHeader basics (supports the alias table above) ─────────────────
  it("normalizeHeader lowercases, strips BOM/quotes, collapses separators, trims", () => {
    expect(normalizeHeader('﻿"Units_Per-Box"  ')).toBe("units per box");
    expect(normalizeHeader("Price Tier 2")).toBe("price tier 2");
  });
});
