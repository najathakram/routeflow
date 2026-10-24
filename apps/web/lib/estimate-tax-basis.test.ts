import { estimateTaxBasisNotice, type EstimateTaxBasis } from "./estimate-tax-basis";

const basis = (over: Partial<EstimateTaxBasis> = {}): EstimateTaxBasis => ({
  quotedTax: 5,
  currentTax: 8,
  delta: 3,
  changed: true,
  quotedRate: 0.05,
  currentRate: 0.08,
  ...over,
});

describe("estimateTaxBasisNotice (H5: converting re-takes today's tax basis)", () => {
  it("says nothing when the tax did not move, or when the server sent no basis (an older API)", () => {
    expect(estimateTaxBasisNotice(basis({ changed: false, delta: 0, currentTax: 5 }))).toBeNull();
    expect(estimateTaxBasisNotice(undefined)).toBeNull();
    expect(estimateTaxBasisNotice(null)).toBeNull();
  });

  it("a higher tax names the quoted and the current amounts and the difference", () => {
    expect(estimateTaxBasisNotice(basis())).toBe(
      "Tax was recalculated at today's rate: $8.00 on the invoice, $3.00 more than the $5.00 quoted.",
    );
  });

  it("a lower tax (the customer became exempt, or the rate fell) says less", () => {
    expect(estimateTaxBasisNotice(basis({ currentTax: 0, delta: -5, currentRate: 0 }))).toBe(
      "Tax was recalculated at today's rate: $0.00 on the invoice, $5.00 less than the $5.00 quoted.",
    );
  });

  it("a legacy untaxed quote (nothing was quoted) still says what changed", () => {
    expect(
      estimateTaxBasisNotice(basis({ quotedTax: 0, currentTax: 5, delta: 5, quotedRate: 0 })),
    ).toBe(
      "Tax was recalculated at today's rate: $5.00 on the invoice, $5.00 more than the $0.00 quoted.",
    );
  });

  it("a regulated levy the quote did not carry is named even when the regular tax did not move (SA must 2)", () => {
    expect(
      estimateTaxBasisNotice(
        basis({ currentTax: 5, delta: 0, currentLevy: 10, invoiceTax: 15, changed: true }),
      ),
    ).toBe("A regulated-category levy of $10.00 was added; the quote carried none.");
  });

  it("both clauses when the rate moved and a levy was added", () => {
    expect(estimateTaxBasisNotice(basis({ currentLevy: 10, invoiceTax: 18 }))).toBe(
      "Tax was recalculated at today's rate: $8.00 on the invoice, $3.00 more than the $5.00 quoted. " +
        "A regulated-category levy of $10.00 was added; the quote carried none.",
    );
  });

  it("never reads a server sentence: a malformed basis is treated as no basis", () => {
    expect(estimateTaxBasisNotice({ changed: true, delta: "x" } as never)).toBeNull();
    expect(estimateTaxBasisNotice({ changed: true } as never)).toBeNull();
  });
});
