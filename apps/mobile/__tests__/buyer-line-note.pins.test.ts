/**
 * WP2 — PINS for the buyer-facing mobile note render (R5.6, R5.7), extended
 * for multi-line notes (truncation raised 2 -> 4 on order/invoice detail
 * screens per the lead's ruling — the template row stays at 2, untouched).
 * Source-text pin (the RN component can't be rendered under the mobile Jest
 * env — see jest.config.js) mirroring the convention of
 * `invoice-print-tile.pins.test.ts`.
 *
 * `(customer)/invoices/[id].tsx` and `(customer)/orders/[id].tsx` each render
 * a guarded `item.notes` line under the existing meta line (HL-3). The
 * OPERATOR invoice screen's `{it.notes}` render was also touched by the
 * multi-line notes change (same numberOfLines raise) — no longer a "buyer
 * screens only" NEG case, so it now gets the same positive assertion.
 */
import { readFileSync } from "fs";
import { join } from "path";

const BUYER_INVOICE_PATH = join(__dirname, "..", "app", "(customer)", "invoices", "[id].tsx");
const BUYER_ORDER_PATH = join(__dirname, "..", "app", "(customer)", "orders", "[id].tsx");
const OPERATOR_INVOICE_PATH = join(
  __dirname,
  "..",
  "app",
  "(operator)",
  "(tabs)",
  "invoices",
  "[id].tsx",
);

describe("pin: buyer-facing per-line note render", () => {
  const buyerInvoiceSrc = readFileSync(BUYER_INVOICE_PATH, "utf8");
  const buyerOrderSrc = readFileSync(BUYER_ORDER_PATH, "utf8");
  const operatorInvoiceSrc = readFileSync(OPERATOR_INVOICE_PATH, "utf8");

  it("buyer invoice detail renders a guarded itemNote Text, truncated at 4 lines (was 2)", () => {
    expect(buyerInvoiceSrc).toMatch(/item\.notes\?\.trim\(\)\s*\?/);
    expect(buyerInvoiceSrc).toMatch(/<Text style=\{styles\.itemNote\} numberOfLines=\{4\}>/);
  });

  it("buyer order detail renders a guarded itemNote Text, truncated at 4 lines (was 2)", () => {
    expect(buyerOrderSrc).toMatch(/item\.notes\?\.trim\(\)\s*\?/);
    expect(buyerOrderSrc).toMatch(/<Text style=\{styles\.itemNote\} numberOfLines=\{4\}>/);
  });

  it("operator invoice screen's {it.notes} render is truncated at 4 lines too (still exactly once)", () => {
    const matches = operatorInvoiceSrc.match(/\{it\.notes\}/g) ?? [];
    expect(matches.length).toBe(1);
    expect(operatorInvoiceSrc).toMatch(
      /<Text style=\{\[styles\.itemSub, \{ fontStyle: "italic" \}\]\} numberOfLines=\{4\}>/,
    );
  });
});
