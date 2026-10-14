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
      /listCommitTierPatch\(\s*listFocusRef\.current,\s*text \?\? form\.pricePerUnit,\s*form,\s*touchedTiersRef\.current,?\s*\)/,
    );
    expect(src).toMatch(/onEndEditing=\{\(e\) => onListEndEditing\(e\.nativeEvent\.text\)\}/);
    expect((src.match(/touchedTiersRef\.current\.add\("priceTier[2-5]"\)/g) ?? []).length).toBe(4);
  });

  it("#3470 review: Expo web fires only onBlur, so every price field commits on onBlur too, once per focus", () => {
    expect(src).toMatch(/onBlur=\{\(\) => onListEndEditing\(\)\}/);
    for (const k of ["priceTier2", "priceTier3", "priceTier4", "priceTier5"])
      expect(src).toContain(`onBlur={() => onTierEndEditing("${k}")}`);
    expect(src).toMatch(/if \(!pendingCommitRef\.current\.delete\("pricePerUnit"\)\) return;/);
    expect(src).toMatch(/if \(!pendingCommitRef\.current\.delete\(field\)\) return;/);
  });

  it("#3470 review: submit re-applies the list cascade from the list the form opened with", () => {
    expect(src).toMatch(
      /listCommitTierPatch\(\s*initial\.pricePerUnit,\s*form\.pricePerUnit,\s*form,\s*touchedTiersRef\.current,?\s*\)/,
    );
    expect(src).toMatch(/buildProductPayload\(final, mode\)/);
  });
});
