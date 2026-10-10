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
