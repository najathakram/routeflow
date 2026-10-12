import { readFileSync } from "fs";
import { join } from "path";
import { buyerInvoiceTotalsRows, totalsRowText } from "../lib/buyer-invoice-totals";

// Follow-up to row 398: the customer app's invoice shows Subtotal, Tax, each named charge, Discount and Shipping from the
// server's own figures, never a hard-coded tax name or rate.
describe("buyerInvoiceTotalsRows", () => {
  const crv = { key: "0", label: "CRV deposit", amount: 2.8 };

  it("31.48 + 2.60 tax + 2.80 CRV deposit: every shown part, and nothing that is hard-coded", () => {
    const rows = buyerInvoiceTotalsRows({
      subtotal: 31.48,
      taxAmount: 5.4,
      regularTaxAmount: 2.6,
      chargeLines: [crv],
      total: 36.88,
    });
    expect(rows).toEqual([
      { key: "subtotal", label: "Subtotal", amount: 31.48 },
      { key: "tax", label: "Tax", amount: 2.6 },
      { key: "charge-0", label: "CRV deposit", amount: 2.8 },
    ]);
  });

  it("a discount is a negative row and shipping a positive one, after the tax and charges", () => {
    const rows = buyerInvoiceTotalsRows({
      subtotal: 40,
      taxAmount: 3.3,
      regularTaxAmount: 3.3,
      chargeLines: [],
      discount: "5.00",
      shippingFee: "4.00",
      total: 42.3,
    });
    expect(rows.map((r) => [r.key, r.amount])).toEqual([
      ["subtotal", 40],
      ["tax", 3.3],
      ["discount", -5],
      ["shipping", 4],
    ]);
  });

  it("an older server (no regularTaxAmount / chargeLines) shows the stored header as Tax", () => {
    expect(buyerInvoiceTotalsRows({ subtotal: 10, taxAmount: 0.83, total: 10.83 })).toEqual([
      { key: "subtotal", label: "Subtotal", amount: 10 },
      { key: "tax", label: "Tax", amount: 0.83 },
    ]);
  });

  it("no tax, no levy, no discount, no shipping: just the subtotal; no subtotal: nothing", () => {
    expect(buyerInvoiceTotalsRows({ subtotal: 20, taxAmount: 0, total: 20 })).toEqual([
      { key: "subtotal", label: "Subtotal", amount: 20 },
    ]);
    expect(buyerInvoiceTotalsRows({ total: 20 })).toEqual([]);
  });
});

describe("totalsRowText: the sign is in the text", () => {
  it("a discount reads -$5.00, a charge $2.80, never a bare or doubled sign", () => {
    expect(totalsRowText({ key: "discount", label: "Discount", amount: -5 })).toBe(
      "Discount: -$5.00",
    );
    expect(totalsRowText({ key: "c", label: "CRV deposit", amount: 2.8 })).toBe(
      "CRV deposit: $2.80",
    );
  });
});

describe("customer invoice screen wiring (source-pinned: RN screens are not renderable in this lane)", () => {
  const src = readFileSync(join(__dirname, "..", "app/(customer)/invoices/[id].tsx"), "utf8");

  it("renders the rows from buyerInvoiceTotalsRows and carries no hard-coded tax name or rate", () => {
    expect(src).toMatch(/buyerInvoiceTotalsRows\(/);
    expect(src).not.toMatch(/GST/);
    expect(src).not.toMatch(/invoice\.tax\b/);
  });
});
