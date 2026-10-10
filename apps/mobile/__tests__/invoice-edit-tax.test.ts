import { hydratedLineTax } from "../lib/invoice-edit-tax";
import { invoiceLineDto } from "../lib/invoice-totals";

/** B294 (REG-B294, SA-141): the operator invoice edit keeps a legacy invoice's sales tax. */
describe("B294 — mobile invoice edit hydration", () => {
  it("REG-B294: a legacy $100 invoice at 7.5% (lines stored at 0) loads taxable at 0.075", () => {
    expect(
      hydratedLineTax({ subtotal: 100, taxAmount: 7.5, items: [{ taxRate: 0 }, { taxRate: 0 }] }),
    ).toEqual([
      { taxRate: 0.075, taxable: true },
      { taxRate: 0.075, taxable: true },
    ]);
  });

  it("REG-B294: the saved payload carries that rate, never 0", () => {
    const [tax] = hydratedLineTax({ subtotal: 100, taxAmount: 7.5, items: [{ taxRate: 0 }] });
    const dto = invoiceLineDto(
      { description: "Sample Cola 12pk", qty: 1, unitPrice: 95, taxable: tax.taxable },
      tax.taxRate,
    );
    expect(dto.taxRate).toBe(0.075);
  });

  it("PIN-B294-mixed: a line with its own rate keeps it, and a 0 line stays untaxed", () => {
    expect(
      hydratedLineTax({
        subtotal: 100,
        taxAmount: 3.75,
        items: [{ taxRate: 0.075 }, { taxRate: 0 }],
      }),
    ).toEqual([
      { taxRate: 0.075, taxable: true },
      { taxRate: 0, taxable: false },
    ]);
  });

  it("PIN-B294-untaxed: an untaxed invoice stays untaxed", () => {
    expect(hydratedLineTax({ subtotal: 100, taxAmount: 0, items: [{ taxRate: 0 }] })).toEqual([
      { taxRate: 0, taxable: false },
    ]);
  });
});
