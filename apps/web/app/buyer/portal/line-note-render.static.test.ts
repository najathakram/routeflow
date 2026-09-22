import { readFileSync } from "fs";
import { join } from "path";

/**
 * WP2 — R5.9 sweep, R5.10 extended for multi-line notes. Static pin on the
 * buyer web renderers (the invoice-detail render is also proven behaviorally
 * by `page.line-note.test.tsx`'s RTL test — this file pins it too, plus the
 * order-detail render which has no RTL coverage) AND on the operator
 * (dashboard) invoice detail's `{item.notes}` render — the multi-line notes
 * change touched that one too (no extracted component to hang an RTL test
 * off of, see the PR), so it now carries the same NOTE_CLASS as the buyer
 * surfaces rather than being a NEG case.
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
// Multi-line notes (B-notes-multiline): a bare "\n" collapses to a space in a plain <p>, so the
// class picked up `whitespace-pre-line`. Updated deliberately, not fought — see the PR.
const NOTE_CLASS = "mt-0.5 whitespace-pre-line text-xs font-normal italic text-navy/60";

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

  it("operator (dashboard) invoice detail renders {item.notes} exactly once with the NP marker", () => {
    const matches = operatorInvoiceSrc.match(/\{item\.notes\}/g) ?? [];
    expect(matches.length).toBe(1);
    expect(operatorInvoiceSrc).toContain(`className="${NOTE_CLASS}"`);
  });
});
