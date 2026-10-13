import { saleTotals } from "./sale-totals";
import { sumInvoiceTotals } from "./invoice-totals";

const cola = { unitPrice: 10, qty: 4 };
const excise = {
  unitPrice: 10,
  qty: 4,
  category: { taxType: "EXCISE_PER_UNIT" as const, rate: 0.5 },
};
const deposit = {
  unitPrice: 10,
  qty: 4,
  category: { taxType: "DEPOSIT_PER_CONTAINER" as const, rate: 0.1 },
};

describe("saleTotals: the one footer the till, the order and the invoice share", () => {
  it("adds the excise and deposit levy on top of the sales tax (CQ-01)", () => {
    const t = saleTotals([excise, deposit], { taxRate: 0.0825 });
    expect(t.subtotal).toBe(80);
    expect(t.regularTax).toBe(6.6);
    expect(t.categoryTax).toBe(2.4);
    expect(t.total).toBe(89);
    expect(t.lineCategoryTax).toEqual([2, 0.4]);
  });

  it("a tax-exempt customer owes $0 of the sales tax AND the levy (CQ-02)", () => {
    const t = saleTotals([excise, deposit], { taxRate: 0.0825, isTaxExempt: true });
    expect(t).toMatchObject({ subtotal: 80, regularTax: 0, categoryTax: 0, tax: 0, total: 80 });
    expect(t.lineCategoryTax).toEqual([0, 0]);
  });

  it("equals sumInvoiceTotals over the same stored lines (one formula, never a second)", () => {
    const t = saleTotals([cola, excise], { taxRate: 0.0825, discount: 1.5, shipping: 3 });
    const s = sumInvoiceTotals(
      [
        { subtotal: 40, taxRate: 0.0825, categoryTaxAmount: 0 },
        { subtotal: 40, taxRate: 0.0825, categoryTaxAmount: 2 },
      ],
      { discount: 1.5, shipping: 3 },
    );
    expect({
      ...t,
      lineTotals: undefined,
      lineCategoryTax: undefined,
      chargeLines: undefined,
    }).toEqual({
      ...s,
      lineTotals: undefined,
      lineCategoryTax: undefined,
      chargeLines: undefined,
    });
  });

  it("a boxed line's levy is on PIECES, its price prorated (never boxes x pack twice)", () => {
    // 2 cases of 24 + 6 loose pieces at 12.00 per case, deposit 0.05 / container
    const t = saleTotals(
      [
        {
          unitPrice: 12,
          qty: 54,
          boxes: 2,
          pieces: 6,
          unitsPerBox: 24,
          category: { taxType: "DEPOSIT_PER_CONTAINER", rate: 0.05 },
        },
      ],
      { taxRate: 0 },
    );
    expect(t.subtotal).toBe(27);
    expect(t.categoryTax).toBe(2.7);
    expect(t.total).toBe(29.7);
  });

  it("an unregulated cart with no rate is just its subtotal", () => {
    expect(saleTotals([cola])).toMatchObject({ subtotal: 40, tax: 0, total: 40 });
  });
});
