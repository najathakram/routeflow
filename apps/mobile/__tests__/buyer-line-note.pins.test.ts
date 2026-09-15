/**
 * WP2 — PINS for the buyer-facing mobile note render (R5.6, R5.7; NEG R5.10).
 * Source-text pin (the RN component can't be rendered under the mobile Jest
 * env — see jest.config.js) mirroring the convention of
 * `invoice-print-tile.pins.test.ts`.
 *
 * `(customer)/invoices/[id].tsx` and `(customer)/orders/[id].tsx` each render
 * a guarded `item.notes` line under the existing meta line (HL-3). NEG: the
 * pre-existing OPERATOR invoice screen's `{it.notes}` render (unrelated,
 * already shipped) must not have doubled — this change touches buyer screens
 * only.
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

  it("buyer invoice detail renders a guarded itemNote Text", () => {
    expect(buyerInvoiceSrc).toMatch(/item\.notes\?\.trim\(\)\s*\?/);
    expect(buyerInvoiceSrc).toMatch(/<Text style=\{styles\.itemNote\} numberOfLines=\{2\}>/);
  });

  it("buyer order detail renders a guarded itemNote Text", () => {
    expect(buyerOrderSrc).toMatch(/item\.notes\?\.trim\(\)\s*\?/);
    expect(buyerOrderSrc).toMatch(/<Text style=\{styles\.itemNote\} numberOfLines=\{2\}>/);
  });

  it("NEG: the operator invoice screen's pre-existing {it.notes} render is unchanged (still exactly once)", () => {
    const matches = operatorInvoiceSrc.match(/\{it\.notes\}/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
