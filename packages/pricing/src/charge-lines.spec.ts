import { categoryChargeLabel, chargeLinesOf } from "./charge-lines";

describe("categoryChargeLabel", () => {
  it.each([
    ["CRV", "DEPOSIT_PER_CONTAINER", "CRV deposit"],
    ["Tobacco", "EXCISE_PER_UNIT", "Tobacco excise"],
    ["Bottle deposit", "DEPOSIT_PER_CONTAINER", "Bottle deposit"],
    ["Cigar excise tax", "EXCISE_PER_UNIT", "Cigar excise tax"],
    ["Sugar", "PERCENT_OF_SALE", "Sugar tax"],
    ["", "DEPOSIT_PER_CONTAINER", "Deposit"],
  ])("%s / %s -> %s", (name, type, label) => {
    expect(categoryChargeLabel(name, type)).toBe(label);
  });
});

describe("chargeLinesOf", () => {
  it("groups one charge per category in first-seen order and leaves zero lines out", () => {
    expect(
      chargeLinesOf([
        {
          categoryTaxAmount: 0.4,
          categoryId: "a",
          categoryName: "CRV",
          categoryTaxType: "DEPOSIT_PER_CONTAINER",
        },
        { categoryTaxAmount: 0 },
        {
          categoryTaxAmount: "2.00",
          categoryId: "b",
          categoryName: "Tobacco",
          categoryTaxType: "EXCISE_PER_UNIT",
        },
        {
          categoryTaxAmount: 0.8,
          categoryId: "a",
          categoryName: "CRV",
          categoryTaxType: "DEPOSIT_PER_CONTAINER",
        },
      ]),
    ).toEqual([
      { key: "a", label: "CRV deposit", amount: 1.2 },
      { key: "b", label: "Tobacco excise", amount: 2 },
    ]);
  });
  it("a refund's negative levy is its own charge, a net zero disappears", () => {
    expect(
      chargeLinesOf([
        {
          categoryTaxAmount: 1,
          categoryId: "a",
          categoryName: "CRV",
          categoryTaxType: "DEPOSIT_PER_CONTAINER",
        },
        {
          categoryTaxAmount: -1,
          categoryId: "a",
          categoryName: "CRV",
          categoryTaxType: "DEPOSIT_PER_CONTAINER",
        },
      ]),
    ).toEqual([]);
  });
  it("no regulated lines: no charges", () => {
    expect(chargeLinesOf([{ categoryTaxAmount: 0 }, {}])).toEqual([]);
  });
});
