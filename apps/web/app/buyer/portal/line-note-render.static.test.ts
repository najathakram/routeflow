import { readFileSync } from "fs";
import { join } from "path";

/**
 * WP2 — R5.9 sweep + NEG R5.10. Static pin on the two remaining buyer web
 * renderers (the invoice-detail render is proven behaviorally by
 * `page.line-note.test.tsx`'s RTL test — this file pins it too, plus the
 * order-detail render which has no RTL coverage). NEG: the operator
 * (dashboard) invoice detail's pre-existing `{item.notes}` render must stay
 * at exactly one occurrence — this sweep touches buyer surfaces only.
 */
const BUYER_INVOICE_PATH = join(__dirname, "[seller]", "invoices", "[id]", "page.tsx");
const BUYER_ORDER_PATH = join(__dirname, "[seller]", "orders", "[id]", "page.tsx");
const OPERATOR_INVOICE_PATH = join(
  __dirname,
  "..",
  "..",
  "(dashboard)",
  "invoices",
  "[id]",
  "page.tsx",
);
const NOTE_CLASS = "mt-0.5 text-xs font-normal italic text-navy/60";

describe("static pin: buyer web per-line note render (R5.9 sweep)", () => {
  const buyerInvoiceSrc = readFileSync(BUYER_INVOICE_PATH, "utf8");
  const buyerOrderSrc = readFileSync(BUYER_ORDER_PATH, "utf8");
  const operatorInvoiceSrc = readFileSync(OPERATOR_INVOICE_PATH, "utf8");

  it("buyer invoice detail renders {item.notes} exactly once with the NP marker", () => {
    const matches = buyerInvoiceSrc.match(/\{item\.notes\}/g) ?? [];
    expect(matches.length).toBe(1);
    expect(buyerInvoiceSrc).toContain(`className="${NOTE_CLASS}"`);
  });

  it("buyer order detail renders {li.notes} exactly once with the NP marker", () => {
    const matches = buyerOrderSrc.match(/\{li\.notes\}/g) ?? [];
    expect(matches.length).toBe(1);
    expect(buyerOrderSrc).toContain(`className="${NOTE_CLASS}"`);
  });

  it("NEG: the operator (dashboard) invoice detail's pre-existing {item.notes} render is unchanged (still exactly once)", () => {
    const matches = operatorInvoiceSrc.match(/\{item\.notes\}/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
