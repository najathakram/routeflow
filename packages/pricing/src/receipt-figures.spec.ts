import { receiptFigures } from "./receipt-figures";
import { billedChargeLines, invoiceTaxSplit } from "./charge-lines";

const crv = { key: "crv", label: "CRV deposit", amount: 2.8 };

describe("receiptFigures: tax, named charges and adjustments (CQ-03)", () => {
  it("the deposit is its own charge, tax is only the sales tax, no Adjustments (31.48 + 2.60 + 2.80 = 36.88)", () => {
    expect(receiptFigures({ netSubtotal: 31.48, total: 36.88, tax: 2.6, charges: [crv] })).toEqual({
      tax: 2.6,
      charges: [crv],
      adjustments: 0,
    });
  });

  it("an exempt customer's older order: a stored tax the total never carried is not printed and reversed", () => {
    expect(receiptFigures({ netSubtotal: 52.89, total: 52.89, tax: 4.36 })).toEqual({
      tax: 0,
      charges: [],
      adjustments: 0,
    });
  });

  it("a real re-price or credit stays in Adjustments", () => {
    expect(receiptFigures({ netSubtotal: 30, total: 31.5, tax: 2.5, charges: [] })).toEqual({
      tax: 2.5,
      charges: [],
      adjustments: -1,
    });
  });

  it("no tax and no charges: nothing to print below the subtotal", () => {
    expect(receiptFigures({ netSubtotal: 20, total: 20, tax: 0 })).toEqual({
      tax: 0,
      charges: [],
      adjustments: 0,
    });
  });
});

describe("billedChargeLines: the invoice's own items", () => {
  it("names one charge per category from the stored lines, using the category row or the frozen type", () => {
    expect(
      billedChargeLines([
        {
          categoryTaxAmount: "0.40",
          trackedCategoryId: "a",
          trackedCategory: { id: "a", name: "CRV", taxType: "DEPOSIT_PER_CONTAINER" },
        },
        { categoryTaxAmount: 0, trackedCategoryId: null },
        { categoryTaxAmount: 2, trackedCategoryId: "b", categoryTaxType: "EXCISE_PER_UNIT" },
      ]),
    ).toEqual([
      { key: "a", label: "CRV deposit", amount: 0.4 },
      { key: "b", label: "Excise", amount: 2 },
    ]);
  });
});

describe("invoiceTaxSplit: the invoice shows Tax and each named charge apart (CQ-03)", () => {
  const items = [
    {
      categoryTaxAmount: "2.80",
      trackedCategoryId: "a",
      trackedCategory: { id: "a", name: "CRV", taxType: "DEPOSIT_PER_CONTAINER" },
    },
    { categoryTaxAmount: 0 },
  ];
  it("Tax 5.40 with a 2.80 deposit inside it is Tax 2.60 plus 'CRV deposit 2.80'", () => {
    expect(invoiceTaxSplit(5.4, items)).toEqual({
      tax: 2.6,
      charges: [{ key: "a", label: "CRV deposit", amount: 2.8 }],
    });
  });
  it("an exempt customer's invoice (levy 0, tax 0) shows neither", () => {
    expect(invoiceTaxSplit(0, [{ categoryTaxAmount: 0 }])).toEqual({ tax: 0, charges: [] });
  });
  it("a header smaller than its lines' levy is shown whole, never negative", () => {
    expect(invoiceTaxSplit(1, items)).toEqual({ tax: 1, charges: [] });
  });
});
