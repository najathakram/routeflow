import * as fs from "fs";
import * as path from "path";

/**
 * Audit 2026-10-14 (money): the DETAIL page's list field did not move tiers 2-5 (a raise left them at the old price),
 * and the products list's two inline copies froze 0 tiers and left equal tiers behind in a mixed ladder. Every list
 * change now goes through applyLadderChange("pricePerUnit", …) (SA ruling: equal moves, 0 stays, above is capped).
 * Source pins: both pages are thousands of lines; the behaviour is pinned in lib/product-tier-patch.test.ts and
 * packages/pricing/src/ladder-change.spec.ts.
 */
const detail = fs.readFileSync(path.join(__dirname, "[id]/page.tsx"), "utf8");
const list = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("list-price changes move tiers by the one ladder rule", () => {
  it("detail page: the product save and the variant modal build their tiers with editTierPatch", () => {
    expect(detail).toMatch(/\.\.\.detailsPricePatch\(product, draft, /);
    expect(detail).toMatch(/\.\.\.editTierPatch\(editingVariant as any, vDraft\)/);
    expect(detail).not.toMatch(/priceTier[2-5]: asDecimal\(/);
    expect(detail).toMatch(/data-testid="tiers-move-note"/);
  });

  it("products list: the quick-save and the price editor use applyLadderChange('pricePerUnit') and name the moves", () => {
    const calls = list.match(/applyLadderChange\(\s*"pricePerUnit",/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(list).not.toMatch(/allSameAsOld/);
    expect(list).not.toMatch(/tierPrice > newPrice/);
    expect(
      (list.match(/\.\.\.\(ladderNote \? \{ description: ladderNote \} : \{\}\)/g) ?? []).length,
    ).toBe(2);
  });

  it("#3470 review: the detail note and the variant toast NAME the moved tiers; the variant modal uses one list value", () => {
    expect(detail).toMatch(
      /ladderChangeNote\(\s*editTierPatchMoves\(product, editDraft as Record<string, string>\),/,
    );
    expect(detail).not.toMatch(/TIERS_MOVE_NOTE/);
    expect(detail).toMatch(
      /const vList = variantForm\.price \|\| String\(editingVariant\.pricePerUnit\);/,
    );
    expect(detail).toMatch(/pricePerUnit: vList,/);
    expect(detail).toMatch(/\.\.\.\(vMoved \? \{ description: vMoved \} : \{\}\)/);
  });
});
