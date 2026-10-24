import { categoryTaxSnapshotOf, recomputeCategoryTax } from "./index";

/**
 * B297 PR3 (SA-734r2 B3 / R4 / L1): recomputing a stored line's category tax reads the line's OWN rate
 * snapshot, never the live category. A NULL (or partly NULL) trio prices at the live category ONCE and
 * stamps it; a line with no category keeps a non-zero stored amount (never zeroed silently).
 */
const FULL = {
  trackedCategoryId: "cat-1",
  categoryTaxType: "EXCISE_PER_UNIT" as const,
  categoryTaxRate: 0.05,
  categoryPriceIncludesTax: false,
};
const LIVE_RAISED = { taxType: "EXCISE_PER_UNIT" as const, rate: 0.07, priceIncludesTax: false };

describe("recomputeCategoryTax", () => {
  describe("a line with its own trio", () => {
    it("prices at the SNAPSHOT rate and ignores a raised live category", () => {
      const r = recomputeCategoryTax(
        { ...FULL, storedAmount: 0.6, unitBasisQty: 12, lineSubtotal: 100 },
        LIVE_RAISED,
      );
      expect(r.amount).toBe(0.6);
      expect(r.reason).toBe("snapshot");
      expect(r.stamp).toBeNull();
      expect(r.warn).toBeNull();
    });

    it("recomputes a changed quantity at the snapshot rate, not the live one", () => {
      const r = recomputeCategoryTax(
        { ...FULL, storedAmount: 0.6, unitBasisQty: 6, lineSubtotal: 50 },
        LIVE_RAISED,
      );
      expect(r.amount).toBe(0.3);
    });

    it("never needs the live category (the caller fetches it for NULL-trio lines only)", () => {
      const r = recomputeCategoryTax({
        ...FULL,
        storedAmount: 0.6,
        unitBasisQty: 12,
        lineSubtotal: 100,
      });
      expect(r.amount).toBe(0.6);
    });

    it("PERCENT_OF_SALE reads the subtotal, with the embedded portion when the price includes tax", () => {
      const pct = { ...FULL, categoryTaxType: "PERCENT_OF_SALE" as const, categoryTaxRate: 0.06 };
      expect(
        recomputeCategoryTax({ ...pct, storedAmount: 6, unitBasisQty: 12, lineSubtotal: 100 })
          .amount,
      ).toBe(6);
      expect(
        recomputeCategoryTax({
          ...pct,
          categoryPriceIncludesTax: true,
          storedAmount: 5.66,
          unitBasisQty: 12,
          lineSubtotal: 100,
        }).amount,
      ).toBe(5.66);
      // the subtotal halves, the amount halves (prorated by the subtotal ratio)
      expect(
        recomputeCategoryTax({ ...pct, storedAmount: 6, unitBasisQty: 6, lineSubtotal: 50 }).amount,
      ).toBe(3);
    });

    it("keeps a zero-rate snapshot at 0 even after the live rate rose (the headline case)", () => {
      const r = recomputeCategoryTax(
        { ...FULL, categoryTaxRate: 0, storedAmount: 0, unitBasisQty: 12, lineSubtotal: 100 },
        LIVE_RAISED,
      );
      expect(r.amount).toBe(0);
      expect(r.stamp).toBeNull();
    });

    it("accepts Decimal-shaped and string rates from the database", () => {
      const r = recomputeCategoryTax({
        ...FULL,
        categoryTaxRate: { toNumber: () => 0.05 } as any,
        storedAmount: "0.60" as any,
        unitBasisQty: 12,
        lineSubtotal: 100,
      });
      expect(r.amount).toBe(0.6);
      expect(
        recomputeCategoryTax({
          ...FULL,
          categoryTaxRate: "0.0500" as any,
          storedAmount: 0.6,
          unitBasisQty: 12,
          lineSubtotal: 100,
        }).amount,
      ).toBe(0.6);
    });

    it("a NONE snapshot is a recorded basis of zero tax", () => {
      const r = recomputeCategoryTax(
        {
          ...FULL,
          categoryTaxType: "NONE" as const,
          storedAmount: 0,
          unitBasisQty: 12,
          lineSubtotal: 100,
        },
        LIVE_RAISED,
      );
      expect(r.amount).toBe(0);
      expect(r.reason).toBe("snapshot");
    });

    it("keeps the sign of a return line", () => {
      const r = recomputeCategoryTax({
        ...FULL,
        storedAmount: -0.6,
        unitBasisQty: -12,
        lineSubtotal: -100,
      });
      expect(r.amount).toBe(-0.6);
    });
  });

  describe("a line with a NULL or partly NULL trio (R4)", () => {
    const NULLS = {
      trackedCategoryId: "cat-1",
      categoryTaxType: null,
      categoryTaxRate: null,
      categoryPriceIncludesTax: null,
    };

    it("prices at the live category ONCE and stamps the full trio it used, with a warn", () => {
      const r = recomputeCategoryTax(
        { ...NULLS, storedAmount: 0.6, unitBasisQty: 12, lineSubtotal: 100 },
        LIVE_RAISED,
      );
      expect(r.amount).toBe(0.84);
      expect(r.reason).toBe("stamped");
      expect(r.stamp).toEqual(categoryTaxSnapshotOf(LIVE_RAISED));
      expect(r.warn).toMatch(/snapshot/i);
    });

    it.each([
      ["type", { ...FULL, categoryTaxType: null }],
      ["rate", { ...FULL, categoryTaxRate: null }],
      ["priceIncludesTax", { ...FULL, categoryPriceIncludesTax: null }],
    ])("a NULL %s alone makes the trio NULL (one predicate)", (_name, partial) => {
      const r = recomputeCategoryTax(
        { ...partial, storedAmount: 0.6, unitBasisQty: 12, lineSubtotal: 100 },
        LIVE_RAISED,
      );
      expect(r.reason).toBe("stamped");
      expect(r.stamp).toEqual(categoryTaxSnapshotOf(LIVE_RAISED));
    });

    it("an undefined trio (a column the caller never loaded) is NULL too", () => {
      const r = recomputeCategoryTax(
        { trackedCategoryId: "cat-1", storedAmount: 0.6, unitBasisQty: 12, lineSubtotal: 100 },
        LIVE_RAISED,
      );
      expect(r.reason).toBe("stamped");
    });

    it("keeps the stored amount, with a warn and no stamp, when the live category is unavailable", () => {
      const r = recomputeCategoryTax({
        ...NULLS,
        storedAmount: 0.6,
        unitBasisQty: 12,
        lineSubtotal: 100,
      });
      expect(r.amount).toBe(0.6);
      expect(r.reason).toBe("kept-unpriceable");
      expect(r.stamp).toBeNull();
      expect(r.warn).toEqual(expect.any(String));
    });
  });

  describe("a line with no category (L1)", () => {
    const NONE = { trackedCategoryId: null, unitBasisQty: 12, lineSubtotal: 100 };

    it("KEEPS a non-zero stored amount, with a warn, instead of zeroing it", () => {
      const r = recomputeCategoryTax({ ...NONE, storedAmount: 4.2 }, LIVE_RAISED);
      expect(r.amount).toBe(4.2);
      expect(r.reason).toBe("kept-no-category");
      expect(r.stamp).toBeNull();
      expect(r.warn).toEqual(expect.any(String));
    });

    it("keeps a stored amount that arrives as a string or a negative figure", () => {
      expect(recomputeCategoryTax({ ...NONE, storedAmount: "4.20" as any }).amount).toBe(4.2);
      expect(recomputeCategoryTax({ ...NONE, storedAmount: -3.1 }).amount).toBe(-3.1);
    });

    it("rounds the kept amount to cents", () => {
      expect(recomputeCategoryTax({ ...NONE, storedAmount: 4.204 }).amount).toBe(4.2);
    });

    it("leaves a zero (or missing) stored amount at 0, with no warn", () => {
      for (const storedAmount of [0, null, undefined, "0.00" as any]) {
        const r = recomputeCategoryTax({ ...NONE, storedAmount }, LIVE_RAISED);
        expect(r.amount).toBe(0);
        expect(r.reason).toBe("none");
        expect(r.warn).toBeNull();
        expect(r.stamp).toBeNull();
      }
    });
  });

  it("does not mutate its inputs", () => {
    const line = { ...FULL, storedAmount: 0.6, unitBasisQty: 12, lineSubtotal: 100 };
    const live = { ...LIVE_RAISED };
    const before = JSON.stringify([line, live]);
    recomputeCategoryTax(line, live);
    recomputeCategoryTax({ ...line, categoryTaxType: null }, live);
    expect(JSON.stringify([line, live])).toBe(before);
  });
});
