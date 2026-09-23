import { readFileSync } from "fs";
import { join } from "path";

/**
 * B784 — the operator invoice EDIT screen must refuse a unit-aware invoice up front
 * (mirrors web's B641 banner) rather than let the operator discover it from the
 * server's 409 UNIT_AWARE_LINE on Save. RN screens aren't renderable in this jest
 * lane (pure-logic only — see credit-limit-wiring.test.ts for the same pattern), so
 * the wiring is source-pinned: today this screen could revert to skipping the
 * hasUnitLine check and every other test would stay green.
 */
describe("B784: the operator invoice edit screen refuses a unit-aware invoice up front", () => {
  it("calls hasUnitLine(invoice.items) and returns the guard before the editable form renders", () => {
    const src = readFileSync(
      join(__dirname, "..", "app/(operator)/(tabs)/invoices/[id]/edit.tsx"),
      "utf8",
    );
    expect(src).toMatch(/hasUnitLine\(invoice\.items\)/);
    // The guard call must sit ON THE SAME early-return branch structure as the
    // existing DRAFT-status and pending-order-mirror guards (both `return guard(`),
    // not just be referenced somewhere unrelated.
    const at = src.indexOf("hasUnitLine(invoice.items)");
    const body = src.slice(at, src.indexOf("return guard(", at) + "return guard(".length);
    expect(body).toContain("return guard(");
  });

  it("names the invoice's own unit label(s) in the refusal, via unitLabelsOf(invoice.items)", () => {
    const src = readFileSync(
      join(__dirname, "..", "app/(operator)/(tabs)/invoices/[id]/edit.tsx"),
      "utf8",
    );
    expect(src).toMatch(/unitLabelsOf\(invoice\.items\)/);
  });
});

/**
 * B797 — recomputeOrderFromInvoices back-syncs an edit onto the LINKED ORDER's
 * unit-aware line even when this invoice's own items carry no unitLabel (same
 * reason the server's assertInvoiceRewriteAllowed checks both). The guard must
 * also refuse on findOne's orderHasUnitAwareLine flag, not just the invoice's
 * own items, and fall back to a generic message when that's the only reason.
 */
describe("B797: the operator invoice edit guard also refuses on orderHasUnitAwareLine", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(operator)/(tabs)/invoices/[id]/edit.tsx"),
    "utf8",
  );

  it("the guard condition also checks invoice.orderHasUnitAwareLine", () => {
    const at = src.indexOf("hasUnitLine(invoice.items)");
    const ifAt = src.lastIndexOf("if (", at);
    const conditionEnd = src.indexOf(") {", at);
    const condition = src.slice(ifAt, conditionEnd);
    expect(condition).toMatch(/invoice\.orderHasUnitAwareLine/);
  });

  it("falls back to a generic message when only the order (not the invoice's own items) is unit-aware", () => {
    expect(src).toMatch(/sold by a unit/i);
  });
});
