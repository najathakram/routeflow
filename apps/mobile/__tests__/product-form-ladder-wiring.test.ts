import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is source-pinned. P0 2026-10-14:
// a tier commit must move lower tiers only through applyLadderChange (old value from the focus snapshot), never the
// old unconditional copy-down, and must name the move under the tiers. The rule itself is pinned in
// packages/pricing/src/ladder-change.spec.ts.
describe("ProductForm tier commit (P0 2026-10-14)", () => {
  const src = readFileSync(join(__dirname, "..", "components/ProductForm.tsx"), "utf8");

  it("uses applyLadderChange with the focus-time value as the old side", () => {
    expect(src).toMatch(
      /applyLadderChange\(field, tierFocusRef\.current\[field\] \?\? "", after, form\)/,
    );
    expect(src).not.toMatch(/cascadeTierPrices/);
  });

  it("a blur with no commit clears the note", () => {
    expect(src).toMatch(/if \(after == null \|\| !changed\) \{\s*setLadderNote\(null\);/);
  });

  it("shows the ladder note under the tiers", () => {
    expect(src).toMatch(/setLadderNote\(ladderChangeNote\(moved,/);
    expect(src).toMatch(/testID="ladder-note"/);
  });

  it("the list field's commit moves tiers by listCommitTierPatch (the shared ladder rule) and typed tiers win", () => {
    expect(src).toMatch(
      /listCommitTierPatch\(listFocusRef\.current, text, form, touchedTiersRef\.current\)/,
    );
    expect(src).toMatch(/onEndEditing=\{\(e\) => onListEndEditing\(e\.nativeEvent\.text\)\}/);
    expect((src.match(/touchedTiersRef\.current\.add\("priceTier[2-5]"\)/g) ?? []).length).toBe(4);
  });
});
