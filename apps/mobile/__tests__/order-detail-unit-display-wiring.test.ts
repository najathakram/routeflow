import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is
// source-pinned — same approach as invoice-detail-unit-display-wiring.test.ts. Order and
// invoice detail screens must show a units_v1 line's own unit (Case, Pallet, a factor-1
// "5 Piece") through the ONE shared formatter, never the generic "box"/"boxes"/a bare
// qty (B757, B758, B759).
describe.each([
  ["operator order detail (B757)", "app/(operator)/(tabs)/orders/[id].tsx", "../../../../lib"],
  ["customer order detail (B759)", "app/(customer)/orders/[id].tsx", "../../../lib"],
  ["customer invoice detail (B758)", "app/(customer)/invoices/[id].tsx", "../../../lib"],
])("%s: shared formatter + unit-display routing", (_name, file, libPrefix) => {
  const src = readFileSync(join(__dirname, "..", file), "utf8");

  it("imports invoiceLineQtyText from @routeflow/pricing and no longer hand-formats the split", () => {
    expect(src).toMatch(/import\s*\{[^}]*invoiceLineQtyText[^}]*\}\s*from\s*"@routeflow\/pricing"/);
    expect(src).not.toMatch(/formatQtySplit/);
  });

  it("routes through usesUnitDisplay from the local invoice-line-display module", () => {
    expect(src).toContain(`from "${libPrefix}/invoice-line-display"`);
    expect(src).toMatch(/usesUnitDisplay\(/);
    expect(src).toMatch(/invoiceLineQtyText\(/);
  });
});

// #2046 REQUIRED (Opus, round 2 on the customer invoice screen): the qty text was fixed
// but the trailing "/ <unit>" price suffix still fell through to item.product?.unit
// unconditionally, so a Case line read "3 Cases x $73.33 / ea" and a factor-1 Piece line
// could read "/ box" — the noun a units_v1 line's own price is PER never matched the noun
// its qty was just named with. Source-pinned the same way as the rest of this file.
// #2046 round 4 (F2 REQUIRED): the customer ORDER detail screen had the same unconditional
// product.unit suffix ("3 Cases x $65.00 / box"), so it carries the same pin.
describe.each([
  ["customer invoice detail (B758 follow-up)", "app/(customer)/invoices/[id].tsx"],
  ["customer order detail (B759 follow-up, #2046 r4)", "app/(customer)/orders/[id].tsx"],
])("%s: the price-suffix noun tracks the line's own unit", (_name, file) => {
  const src = readFileSync(join(__dirname, "..", file), "utf8");

  it("imports invoiceLineUnitNoun from the local invoice-line-display module", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*invoiceLineUnitNoun[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/lib\/invoice-line-display"/,
    );
  });

  it("gates the price-suffix noun on item.unitLabel, falling back to product.unit only when blank", () => {
    const at = src.indexOf("invoiceLineUnitNoun(item)");
    expect(at).toBeGreaterThan(-1);
    // The nearest preceding ternary condition must test item.unitLabel, not a bare
    // usesUnitDisplay(item) or unconditional call — that was the exact defect: a
    // Case/Piece line's PRICE suffix used the live product.unit unconditionally.
    const conditionStart = src.lastIndexOf("\n", src.lastIndexOf("\n", at) - 1);
    const condition = src.slice(conditionStart, at);
    expect(condition).toMatch(/item\.unitLabel\?\.trim\(\)/);
  });
});

// #1208-style regression pin for B757 (operator order detail): fails red on 0aded88e, the
// sha the review was reading — the hardcoded `/ box of ${upb}` suffix, sourced off the LIVE
// product, is gone, replaced by the line's own noun via invoiceLineUnitNoun.
describe("operator order detail (B757): no hardcoded '/ box of' suffix survives", () => {
  const src = readFileSync(join(__dirname, "..", "app/(operator)/(tabs)/orders/[id].tsx"), "utf8");

  it("never hardcodes the word 'box' into the price suffix off a live-product upb", () => {
    expect(src).not.toMatch(/\/ box of \$\{upb\}/);
  });

  it("names the suffix through invoiceLineUnitNoun(li) instead", () => {
    expect(src).toMatch(/invoiceLineUnitNoun\(li\)/);
  });
});
