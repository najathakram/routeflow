import { estimateTaxBasisNotice, type EstimateTaxBasis } from "../lib/estimate-tax-basis";

const basis = (over: Partial<EstimateTaxBasis> = {}): EstimateTaxBasis => ({
  quotedTax: 5,
  currentTax: 8,
  currentLevy: 0,
  invoiceTax: 8,
  delta: 3,
  changed: true,
  quotedRate: 0.05,
  currentRate: 0.08,
  ...over,
});

describe("estimateTaxBasisNotice on mobile (H5: the same shared sentence as web)", () => {
  it("nothing moved, or no basis from an older API: no notice", () => {
    expect(
      estimateTaxBasisNotice(basis({ changed: false, delta: 0, currentTax: 5, invoiceTax: 5 })),
    ).toBeNull();
    expect(estimateTaxBasisNotice(undefined)).toBeNull();
  });

  it("a higher regular tax names the amounts and the difference", () => {
    expect(estimateTaxBasisNotice(basis())).toBe(
      "Tax was recalculated at today's rate: $8.00 on the invoice, $3.00 more than the $5.00 quoted.",
    );
  });

  it("a regulated levy the quote did not carry is named even when the regular tax did not move", () => {
    expect(
      estimateTaxBasisNotice(
        basis({ currentTax: 5, delta: 0, currentLevy: 10, invoiceTax: 15, changed: true }),
      ),
    ).toBe("A regulated-category levy of $10.00 was added; the quote carried none.");
  });

  it("both clauses when the rate moved AND a levy was added", () => {
    expect(estimateTaxBasisNotice(basis({ currentLevy: 10, invoiceTax: 18 }))).toBe(
      "Tax was recalculated at today's rate: $8.00 on the invoice, $3.00 more than the $5.00 quoted. " +
        "A regulated-category levy of $10.00 was added; the quote carried none.",
    );
  });
});
