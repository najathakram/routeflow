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

  // ── I3: money parsers reject negatives and bound to their DTO/column max ────
  describe("I3: money bounds", () => {
    it("pricePerUnit rejects a negative value", () => {
      const col = PRODUCT_COLUMNS.find((c) => c.field === "pricePerUnit")!;
      const r = col.parse("-12");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/must not be negative/);
    });

    it("pricePerUnit rejects a value above the Decimal(10,2) bound (99,999,999.99)", () => {
      const col = PRODUCT_COLUMNS.find((c) => c.field === "pricePerUnit")!;
      const r = col.parse("100000000");
      expect(r.ok).toBe(false);
    });

    it("pricePerUnit accepts exactly the Decimal(10,2) bound", () => {
      const col = PRODUCT_COLUMNS.find((c) => c.field === "pricePerUnit")!;
      const r = col.parse("99999999.99");
      expect(r.ok).toBe(true);
    });

    it("msrp rejects a negative value", () => {
      const col = PRODUCT_COLUMNS.find((c) => c.field === "msrp")!;
      const r = col.parse("-1");
      expect(r.ok).toBe(false);
    });

    it("creditLimit rejects a negative value and bounds to its Decimal(10,2) column, not the DTO's 1e9", () => {
      const col = CUSTOMER_COLUMNS.find((c) => c.field === "creditLimit")!;
      expect(col.parse("-1").ok).toBe(false);
      expect(col.parse("99999999.99").ok).toBe(true);
      // 100,000,000 passes CreateCustomerDto's @Max(1e9) but overflows Decimal(10,2) at write time.
      const over = col.parse("100000000");
      expect(over.ok).toBe(false);
      if (!over.ok) expect(over.reason).toMatch(/99999999\.99 or less/);
    });

    it("an int column bounds to Postgres integer max (a larger cell overflows the Int column)", () => {
      const col = PRODUCT_COLUMNS.find((c) => c.field === "unitsPerBox")!;
      expect(col.parse("2147483647").ok).toBe(true);
      expect(col.parse("2147483648").ok).toBe(false);
    });
  });

  // ── M2: standardCost parses/compares at 4dp, its own (tighter) bound ────────
  describe("M2: standardCost 4dp parser", () => {
    const col = () => PRODUCT_COLUMNS.find((c) => c.field === "standardCost")!;

    it("keeps 4 decimal places instead of rounding to cents", () => {
      const r = col().parse("0.0825");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBeCloseTo(0.0825, 4);
    });

    it("rejects a negative value", () => {
      const r = col().parse("-1.5");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/must not be negative/);
    });

    it("bounds to Decimal(10,4)'s own max (999,999.9999), not the 99,999,999.99 money bound", () => {
      expect(col().parse("999999.9999").ok).toBe(true);
      expect(col().parse("1000000").ok).toBe(false);
    });

    // No mirrors (house rule): the parser now rounds through @routeflow/pricing's
    // `roundUnitCost` rather than a local `roundTo` — pin that it still keeps 4dp and rounds a
    // tie away from zero, exactly like the retired local helper did.
    it("keeps 4dp and rounds a tie away from zero via the real parser (roundUnitCost, no local mirror)", () => {
      const r = col().parse("1.23455");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(1.2346);
    });
  });

  // ── SA-305 (1): identity overflow is a bad cell naming the limit — never a truncation ───
  describe("identity length bounds follow CreateCustomerDto", () => {
    it.each([
      ["notes", 2000],
      ["phone", 40],
      ["mobile", 40],
      ["displayName", 120],
      ["firstName", 80],
      ["lastName", 80],
      ["email", 254],
      ["businessName", 200],
      ["taxId", 40],
    ])("%s accepts %i characters and refuses one more, naming the limit", (field, max) => {
      const col = CUSTOMER_COLUMNS.find((c) => c.field === field)!;
      const atMax = col.parse("x".repeat(max as number));
      expect(atMax.ok).toBe(true);
      if (atMax.ok) expect(atMax.value).toBe("x".repeat(max as number));
      const over = col.parse("x".repeat((max as number) + 1));
      expect(over.ok).toBe(false);
      if (!over.ok) expect(over.reason).toBe(`must be ${max} characters or fewer`);
    });
  });

  // ── M4: "Item Description" restored as a description alias ─────────────────
  it('M4: "Item Description" resolves to the description field', () => {
    const { byField } = resolveColumns(["Item Description"], PRODUCT_COLUMNS);
    expect(byField.description).toBe("Item Description");
  });

  // ── SA-305 (1): Payment Terms integer mapping + the unmapped-integer warning ─
  describe("SA-305 (1): Payment Terms integer mapping", () => {
    const col = () => CUSTOMER_COLUMNS.find((c) => c.field === "defaultPaymentTerms")!;

    it.each([
      ["0", "Due on Receipt"],
      ["15", "Net 15"],
      ["30", "Net 30"],
      ["45", "Net 45"],
      ["60", "Net 60"],
    ])('bare integer "%s" maps to "%s"', (raw, expected) => {
      const r = col().parse(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(expected);
    });

    it.each(["7", "10", "90"])(
      'an unmapped bare integer "%s" imports with terms UNSET and a warning naming it',
      (raw) => {
        const r = col().parse(raw);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value).toBeUndefined();
          expect(r.warning).toMatch(new RegExp(raw));
        }
      },
    );

    it("a genuinely unrecognized (non-integer) term is still a bad cell", () => {
      const r = col().parse("whenever works");
      expect(r.ok).toBe(false);
    });
  });
});
