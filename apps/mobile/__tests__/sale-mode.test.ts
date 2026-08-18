/**
 * §A2 gate contract (.claude/pipeline/decisions/2026-08-18-batch-architecture.md):
 * sale mode (POST /orders/sell) may only replace a plain invoice save when it
 * is provably the SAME invoice. `saleModeGate` applies 6 enumerated rules
 * plus a final integer-cents, zero-tolerance total-equality assertion
 * between `predictSaleInvoiceTotals` (this module's mirror of
 * orders.create -> createInvoiceFromOrder) and `computeInvoiceTotals` (the
 * existing preview). The motivating case: mobile invoice lines are UNTAXED
 * by default while orders.create taxes the whole subtotal, so an
 * all-untaxed invoice under a non-zero tenant rate must be ineligible.
 */
import { predictSaleInvoiceTotals, saleModeGate, type SaleGateInput } from "../lib/sale-mode";
import { computeLineSubtotal, roundMoney } from "../lib/pricing";

function baseInput(overrides: Partial<SaleGateInput> = {}): SaleGateInput {
  return {
    lines: [{ unitPrice: 100, qty: 1, taxRate: 0 }],
    hasUnlistedInvalid: false,
    invDiscount: 0,
    shippingFee: 0,
    isTaxExempt: false,
    taxRateFraction: 0,
    touched: { dueDate: false, terms: false, reference: false, subject: false },
    sendNowOn: false,
    deliveredNow: true,
    hasSeparateInvoiceCategoryLine: false,
    ...overrides,
  };
}

describe("predictSaleInvoiceTotals", () => {
  it("subtotal = Σ computeLineSubtotal(line), never qty × unitPrice directly", () => {
    const lines = [
      { unitPrice: 12, qty: 3 },
      { unitPrice: 4.5, qty: 2 },
    ];
    const t = predictSaleInvoiceTotals({
      lines,
      shippingFee: 0,
      isTaxExempt: false,
      taxRateFraction: 0,
    });
    expect(t.subtotal).toBe(roundMoney(lines.reduce((s, l) => s + computeLineSubtotal(l), 0)));
    expect(t.subtotal).toBe(45);
    expect(t.total).toBe(45);
  });

  it("boxed line prorates through computeLineSubtotal (server-identical proration)", () => {
    // 2 cases + 3 loose of a 6-pack at $12/case → 12×2 + 12×(3/6) = $30.
    const line = { unitPrice: 12, qty: 15, boxes: 2, pieces: 3, unitsPerBox: 6 };
    const t = predictSaleInvoiceTotals({
      lines: [line],
      shippingFee: 0,
      isTaxExempt: false,
      taxRateFraction: 0,
    });
    expect(t.subtotal).toBe(30);
    expect(t.subtotal).toBe(roundMoney(computeLineSubtotal(line)));
  });

  it("taxes the WHOLE subtotal at the tenant rate — never per-line taxRate", () => {
    // Per-line taxRate is deliberately ignored on this path; only
    // taxRateFraction (the tenant rate) drives the sale-path tax.
    const t = predictSaleInvoiceTotals({
      lines: [{ unitPrice: 100, qty: 1, taxRate: 0.5 /* ignored */ }],
      shippingFee: 0,
      isTaxExempt: false,
      taxRateFraction: 0.08,
    });
    expect(t.taxTotal).toBe(8);
    expect(t.total).toBe(108);
  });

  it("never applies a per-line discount (the sale path has no per-line discount field)", () => {
    const t = predictSaleInvoiceTotals({
      lines: [{ unitPrice: 100, qty: 1, discount: 20 /* ignored */ }],
      shippingFee: 0,
      isTaxExempt: false,
      taxRateFraction: 0,
    });
    expect(t.subtotal).toBe(100);
    expect(t.total).toBe(100);
  });

  it("isTaxExempt zeroes tax", () => {
    const t = predictSaleInvoiceTotals({
      lines: [{ unitPrice: 100, qty: 1 }],
      shippingFee: 0,
      isTaxExempt: true,
      taxRateFraction: 0.08,
    });
    expect(t.taxTotal).toBe(0);
    expect(t.total).toBe(100);
  });

  it("shipping is a flat post-tax addend (discount is hardcoded 0 server-side)", () => {
    const t = predictSaleInvoiceTotals({
      lines: [{ unitPrice: 100, qty: 1 }],
      shippingFee: 15,
      isTaxExempt: false,
      taxRateFraction: 0.1,
    });
    expect(t.subtotal).toBe(100);
    expect(t.taxTotal).toBe(10);
    expect(t.total).toBe(125);
  });
});

describe("saleModeGate", () => {
  it("a fully eligible input returns { eligible: true } with no reasons key", () => {
    expect(saleModeGate(baseInput())).toEqual({ eligible: true });
  });

  // (a) — the DEFAULT mobile invoice: untaxed lines under a non-zero tenant
  // rate must be ineligible. This is the case that motivated the gate.
  it("(a) all-untaxed lines + non-zero tenant rate ⇒ ineligible", () => {
    const result = saleModeGate(baseInput({ taxRateFraction: 0.08 }));
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reasons).toContain("some lines aren't taxed");
  });

  // (b) mixed taxable lines ⇒ ineligible
  it("(b) mixed taxable lines ⇒ ineligible", () => {
    const result = saleModeGate(
      baseInput({
        lines: [
          { unitPrice: 100, qty: 1, taxRate: 0.08 },
          { unitPrice: 50, qty: 1, taxRate: 0 },
        ],
        taxRateFraction: 0.08,
      }),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reasons).toContain("some lines aren't taxed");
  });

  // (c) all lines taxable at the tenant rate ⇒ eligible
  it("(c) all lines taxable at the tenant rate ⇒ eligible", () => {
    const result = saleModeGate(
      baseInput({
        lines: [{ unitPrice: 100, qty: 1, taxRate: 0.08 }],
        taxRateFraction: 0.08,
      }),
    );
    expect(result).toEqual({ eligible: true });
  });

  // (d) taxRateFraction === 0 with untaxed lines ⇒ eligible (exempt tenant/customer)
  it("(d) taxRateFraction === 0 with untaxed lines ⇒ eligible", () => {
    const result = saleModeGate(baseInput({ taxRateFraction: 0 }));
    expect(result).toEqual({ eligible: true });
  });

  // (e) invoice discount > 0 ⇒ ineligible EVEN WHEN the totals happen to
  // match numerically — rule 2 is an explicit, independent guard, not just
  // a restatement of the equality assertion. Constructed so a per-line
  // taxRate above the tenant rate inflates the preview's tax by exactly the
  // invoice discount, making the two totals coincide (105 === 105) despite
  // the discount.
  it("(e) invoice discount > 0 ⇒ ineligible even when totals happen to match", () => {
    const lines = [{ unitPrice: 100, qty: 1, taxRate: 0.06 }];
    const taxRateFraction = 0.05;
    const invDiscount = 1;
    // Sanity-check the coincidence this test relies on.
    const predicted = predictSaleInvoiceTotals({
      lines,
      shippingFee: 0,
      isTaxExempt: false,
      taxRateFraction,
    });
    const previewed = computeLineSubtotal(lines[0]); // 100
    expect(predicted.total).toBe(105);
    expect(roundMoney(previewed - invDiscount + roundMoney(previewed * lines[0].taxRate))).toBe(
      105,
    );

    const result = saleModeGate(baseInput({ lines, taxRateFraction, invDiscount }));
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reasons).toContain("the invoice discount is set");
    expect(result.reasons).not.toContain("the totals would not match");
  });

  // (f) each touched header field individually ⇒ ineligible
  it.each(["dueDate", "terms", "reference", "subject"] as const)(
    "(f) touched.%s ⇒ ineligible",
    (field) => {
      const result = saleModeGate(
        baseInput({
          touched: {
            dueDate: false,
            terms: false,
            reference: false,
            subject: false,
            [field]: true,
          },
        }),
      );
      expect(result.eligible).toBe(false);
      if (result.eligible) throw new Error("unreachable");
      expect(result.reasons).toContain("due date / terms / reference are set");
    },
  );

  // (g) deliveredNow: false + sendNowOn ⇒ ineligible
  it("(g) deliveredNow:false + sendNowOn ⇒ ineligible", () => {
    const result = saleModeGate(baseInput({ deliveredNow: false, sendNowOn: true }));
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reasons).toContain("sending now without delivery");
  });

  // deliveredNow: false without sendNowOn stays eligible (create-pending-order path).
  it("deliveredNow:false without sendNowOn stays eligible", () => {
    const result = saleModeGate(baseInput({ deliveredNow: false, sendNowOn: false }));
    expect(result).toEqual({ eligible: true });
  });

  // (h) a boxed line is predicted identically by both paths ⇒ eligible
  it("(h) a boxed line (unitsPerBox > 1) is predicted identically by both paths ⇒ eligible", () => {
    const line = { unitPrice: 12, qty: 15, boxes: 2, pieces: 3, unitsPerBox: 6, taxRate: 0.1 };
    const result = saleModeGate(baseInput({ lines: [line], taxRateFraction: 0.1 }));
    expect(result).toEqual({ eligible: true });
  });

  // (i) multiple simultaneous violations ⇒ all reasons present
  it("(i) multiple simultaneous violations ⇒ all reasons present", () => {
    const result = saleModeGate(
      baseInput({
        lines: [{ unitPrice: 100, qty: 1, discount: 10, taxRate: 0 }],
        invDiscount: 5,
        touched: { dueDate: true, terms: false, reference: false, subject: false },
        deliveredNow: false,
        sendNowOn: true,
        hasSeparateInvoiceCategoryLine: true,
      }),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "a line discount is set",
        "the invoice discount is set",
        "due date / terms / reference are set",
        "sending now without delivery",
        "a regulated item bills on its own invoice",
      ]),
    );
  });

  // Rule 1 in isolation.
  it("a per-line discount alone ⇒ ineligible", () => {
    const result = saleModeGate(
      baseInput({ lines: [{ unitPrice: 100, qty: 1, discount: 5, taxRate: 0 }] }),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reasons).toContain("a line discount is set");
  });

  // Rule 6 in isolation — the only trigger, so the reason list is exact.
  it("a SEPARATE_INVOICE regulated line alone ⇒ ineligible", () => {
    const result = saleModeGate(baseInput({ hasSeparateInvoiceCategoryLine: true }));
    expect(result).toEqual({
      eligible: false,
      reasons: ["a regulated item bills on its own invoice"],
    });
  });

  // The final assertion catches what the enumerated rules miss: every line
  // has a non-zero taxRate (rule 3 passes) but that per-line rate differs
  // from the tenant rate the sale path actually applies, so the totals
  // diverge and only rule 7 can see it.
  it("the equality assertion catches a divergence the 6 enumerated rules miss", () => {
    const result = saleModeGate(
      baseInput({
        lines: [{ unitPrice: 100, qty: 1, taxRate: 0.06 }],
        taxRateFraction: 0.05,
      }),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) throw new Error("unreachable");
    expect(result.reasons).toEqual(["the totals would not match"]);
  });
});
