import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is
// source-pinned — same approach as the invoice/order detail wiring pins. #2222 (SA-168a
// follow-up): the buyer edit-items screen suffixed a line's price with the live
// product.unit, so a units_v1 Case line read "$65.00 / box" or "/ ea". The line's own
// unitLabel must reach the draft and name the price-suffix noun.
describe("customer edit-items (#2222): the line price-suffix noun tracks the line's own unit", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(customer)/orders/[id]/edit-items.tsx"),
    "utf8",
  );

  it("imports invoiceLineUnitNoun from the local invoice-line-display module", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*invoiceLineUnitNoun[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/lib\/invoice-line-display"/,
    );
  });

  it("carries the order line's unitLabel into the draft (hydration lives in lib/buyer-edit-items since #2270)", () => {
    expect(src).toMatch(/hydrateBuyerDraft\(order\.lineItems\)/);
    const lib = readFileSync(join(__dirname, "..", "lib/buyer-edit-items.ts"), "utf8");
    expect(lib).toMatch(/unitLabel:\s*count != null \? li\.unitLabel : null/);
  });

  it("gates the price-suffix noun on item.unitLabel, falling back to the unit only when blank", () => {
    const at = src.indexOf("invoiceLineUnitNoun(item)");
    expect(at).toBeGreaterThan(-1);
    const conditionStart = src.lastIndexOf("\n", src.lastIndexOf("\n", at) - 1);
    expect(src.slice(conditionStart, at)).toMatch(/item\.unitLabel\?\.trim\(\)/);
  });
});
