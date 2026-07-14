/**
 * Pure-logic coverage for apps/mobile/lib/regulated-format.ts — locks the
 * section/subcategory picker-option drift-proofing and the tax/treatment label
 * formatting used by the P10-REG-A regulated-categories screens and the product
 * form's section→subcategory picker.
 */
import {
  sectionPickerOptions,
  subcategoryPickerOptions,
  taxRuleLabel,
  treatmentLabel,
} from "../lib/regulated-format";
import type {
  InvoiceTreatment,
  TrackedCategory,
  TrackedSubcategory,
} from "../lib/api/tracked-categories";

function makeCategory(overrides: Partial<TrackedCategory> = {}): TrackedCategory {
  return {
    id: "cat-1",
    name: "Alcohol",
    taxType: "NONE",
    rate: "0",
    unitBasis: null,
    priceIncludesTax: false,
    invoiceTreatment: "SEPARATE_INVOICE",
    requiresLicense: false,
    reportTemplate: "GENERIC",
    reportCadence: "MONTHLY",
    active: true,
    productCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSubcategory(overrides: Partial<TrackedSubcategory> = {}): TrackedSubcategory {
  return {
    id: "sub-1",
    trackedCategoryId: "cat-1",
    name: "Beer",
    active: true,
    productCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("sectionPickerOptions", () => {
  it("no current → maps active sections 1:1, all inactive:false", () => {
    const sections = [
      makeCategory({ id: "a", name: "Alcohol" }),
      makeCategory({ id: "b", name: "Tobacco" }),
    ];
    expect(sectionPickerOptions(sections)).toEqual([
      { id: "a", name: "Alcohol", inactive: false },
      { id: "b", name: "Tobacco", inactive: false },
    ]);
  });

  it("current whose id IS in the active list → not duplicated", () => {
    const sections = [
      makeCategory({ id: "a", name: "Alcohol" }),
      makeCategory({ id: "b", name: "Tobacco" }),
    ];
    const result = sectionPickerOptions(sections, { id: "a", name: "Alcohol" });
    expect(result).toEqual([
      { id: "a", name: "Alcohol", inactive: false },
      { id: "b", name: "Tobacco", inactive: false },
    ]);
  });

  it("current whose id is NOT in the active list → appended once with inactive:true", () => {
    const sections = [makeCategory({ id: "a", name: "Alcohol" })];
    const result = sectionPickerOptions(sections, { id: "z", name: "Retired Section" });
    expect(result).toEqual([
      { id: "a", name: "Alcohol", inactive: false },
      { id: "z", name: "Retired Section", inactive: true },
    ]);
  });

  it("current omitted/null on an empty active list → []", () => {
    expect(sectionPickerOptions([])).toEqual([]);
    expect(sectionPickerOptions([], null)).toEqual([]);
  });
});

describe("subcategoryPickerOptions", () => {
  it("drops inactive subs whose id != currentId", () => {
    const subs = [
      makeSubcategory({ id: "s1", name: "Beer", active: true }),
      makeSubcategory({ id: "s2", name: "Retired", active: false }),
    ];
    expect(subcategoryPickerOptions(subs, "s1")).toEqual([
      { id: "s1", name: "Beer", inactive: false },
    ]);
  });

  it("keeps an inactive sub whose id == currentId (flagged inactive:true)", () => {
    const subs = [
      makeSubcategory({ id: "s1", name: "Beer", active: true }),
      makeSubcategory({ id: "s2", name: "Retired", active: false }),
    ];
    expect(subcategoryPickerOptions(subs, "s2")).toEqual([
      { id: "s1", name: "Beer", inactive: false },
      { id: "s2", name: "Retired", inactive: true },
    ]);
  });

  it("keeps all active subs regardless of currentId", () => {
    const subs = [
      makeSubcategory({ id: "s1", name: "Beer", active: true }),
      makeSubcategory({ id: "s2", name: "Wine", active: true }),
    ];
    expect(subcategoryPickerOptions(subs, undefined)).toEqual([
      { id: "s1", name: "Beer", inactive: false },
      { id: "s2", name: "Wine", inactive: false },
    ]);
    expect(subcategoryPickerOptions(subs, null)).toEqual([
      { id: "s1", name: "Beer", inactive: false },
      { id: "s2", name: "Wine", inactive: false },
    ]);
  });
});

describe("taxRuleLabel", () => {
  it("EXCISE_PER_UNIT with rate:'2.87', unitBasis:'pack' → '$2.87 / pack'", () => {
    const c = makeCategory({ taxType: "EXCISE_PER_UNIT", rate: "2.87", unitBasis: "pack" });
    expect(taxRuleLabel(c)).toBe("$2.87 / pack");
  });

  it("PERCENT_OF_SALE with rate:'0.05' → '5% of sale' (integer-percent, no decimals)", () => {
    const c = makeCategory({ taxType: "PERCENT_OF_SALE", rate: "0.05" });
    expect(taxRuleLabel(c)).toBe("5% of sale");
  });

  it("PERCENT_OF_SALE with rate:'0.0525' → '5.25% of sale'", () => {
    const c = makeCategory({ taxType: "PERCENT_OF_SALE", rate: "0.0525" });
    expect(taxRuleLabel(c)).toBe("5.25% of sale");
  });

  it("NONE → 'Tracked only · no auto tax'", () => {
    const c = makeCategory({ taxType: "NONE" });
    expect(taxRuleLabel(c)).toBe("Tracked only · no auto tax");
  });

  it("unitBasis:null on a per-unit type → falls back to 'unit'", () => {
    const c = makeCategory({ taxType: "EXCISE_PER_UNIT", rate: "2.87", unitBasis: null });
    expect(taxRuleLabel(c)).toBe("$2.87 / unit");
  });
});

describe("treatmentLabel", () => {
  const cases: [InvoiceTreatment, string][] = [
    ["SEPARATE_INVOICE", "Separate invoice"],
    ["SEPARATE_SECTION", "Sectioned on invoice"],
    ["LINE_TAX", "Per-line tax"],
  ];
  it.each(cases)("%s → %s", (treatment, label) => {
    expect(treatmentLabel(treatment)).toBe(label);
  });
});
