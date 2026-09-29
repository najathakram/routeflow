import { readFileSync } from "fs";
import { join } from "path";

/**
 * #2055: the same "hardcoded '/ box of ${upb}' price suffix" pattern #2046 fixed on the
 * operator/customer order and invoice detail screens also appeared at two more sites.
 * Both screens here are route files jest cannot import (expo-router hooks fire on
 * import), so the wiring is source-pinned — same approach as the #2046 wiring tests.
 * The pure decision itself (`priceUnitSuffix`) is unit-tested for real in
 * `invoice-line-display.test.ts`; this file only proves each screen actually calls it.
 */
describe("#2055: price-suffix noun wiring", () => {
  it("driver at-door adjust.tsx: names the line's own unit via invoiceLineUnitNoun, never the hardcoded word 'box'", () => {
    const src = readFileSync(
      join(__dirname, "..", "app/(driver)/route/stop/[stopId]/adjust.tsx"),
      "utf8",
    );
    expect(src).toMatch(
      /import\s*\{\s*invoiceLineUnitNoun\s*\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/invoice-line-display"/,
    );
    expect(src).toMatch(/invoiceLineUnitNoun\(li\)/);
    expect(src).not.toMatch(/\/ box of \$\{upb\}/);
    // upb itself is unaffected by this fix — it was already line-snapshot-first via
    // lineUnitsPerBox (B657), which this fix must not disturb.
    expect(src).toMatch(/lineUnitsPerBox\(li\)/);
  });

  it("operator edit-items DraftItemCard.tsx (sliced from edit-items.tsx by #2390): routes both the editable and read-only price rows through the shared priceUnitSuffix", () => {
    const src = readFileSync(
      join(__dirname, "..", "components/edit-items/DraftItemCard.tsx"),
      "utf8",
    );
    expect(src).toMatch(
      /import\s*\{\s*priceUnitSuffix\s*\}\s*from\s*"\.\.\/\.\.\/lib\/invoice-line-display"/,
    );
    const calls = src.match(/priceUnitSuffix\(item,\s*upb\)/g) ?? [];
    // Both the canEditPrice and the read-only branch had their own copy of the buggy
    // ternary — both must now call the same shared, tested function. (The product-
    // picker row further down keeps its OWN, deliberately different "box" text — see
    // the next test — so this file still contains one `/ box of` match overall.)
    expect(calls.length).toBe(2);
    // isBoxed's own role/unit-mode gate (stepper UI) is untouched — this fix only
    // changed what the PRICE suffix reads, never the box/piece vs. unit stepper choice.
    expect(src).toMatch(/const isBoxed = upb > 1 && canSplitBoxes && !item\.unitLabel;/);
  });

  it("operator edit-items ProductPicker.tsx's product-picker row (a live CATALOGUE product, not an order line) is deliberately left as plain 'box' — products carry no unitLabel to read", () => {
    const src = readFileSync(
      join(__dirname, "..", "components/edit-items/ProductPicker.tsx"),
      "utf8",
    );
    // Confirms the one remaining `/ box of ${upb}` match is exactly this row (`p`, a
    // product), not a leftover order-line ternary this fix missed.
    const remaining = src.match(/\/ box of \$\{upb\}/g) ?? [];
    expect(remaining).toHaveLength(1);
    expect(src).toMatch(/upb > 1 \? ` \/ box of \$\{upb\}` : p\.unit \? ` \/ \$\{p\.unit\}` : ""/);
  });
});
