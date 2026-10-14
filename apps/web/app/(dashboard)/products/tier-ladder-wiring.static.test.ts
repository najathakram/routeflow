import * as fs from "fs";
import * as path from "path";

/**
 * P0 2026-10-14 (money): a tier commit copied its price into EVERY lower tier, so raising Tier 3 21.00 → 21.25 set a
 * cheaper Tier 4 / Tier 5 to 21.25 (overcharge). Both web surfaces now go through applyLadderChange with the tier's
 * OLD value and name the move. Source pins: both pages are thousands of lines and not mountable here; the rule is
 * pinned in packages/pricing/src/ladder-change.spec.ts.
 */
const detail = fs.readFileSync(path.join(__dirname, "[id]/page.tsx"), "utf8");
const list = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("tier commits go through applyLadderChange with the old value", () => {
  it("neither page uses the old copy-down", () => {
    for (const src of [detail, list]) expect(src).not.toMatch(/cascadeTierPrices/);
  });

  it("detail page: the old side is the field's focus-time value, and the move is shown", () => {
    // SA MUST: the old side is DecimalInput's focus-time value, never a page-held copy (stale after "Set all to
    // Tier 1" or a cleared-field blur).
    expect(detail).toMatch(/onCommit=\{\(v, atFocus\) => \{/);
    expect(detail).toMatch(
      /applyLadderChange\(\s*field as TierField,\s*atFocus \?\? productVal,\s*v,/,
    );
    expect(detail).not.toMatch(/tierCommitBaseRef/);
    expect(detail).toMatch(/onCommit\?: \(v: number, valueAtFocus: number \| null\) => void;/);
    expect(detail).toMatch(/setLadderNote\(\s*ladderChangeNote\(moved,/);
    expect(detail).toMatch(/data-testid="ladder-note"/);
  });

  it("products list inline edit: the old side is the stored tier, and the toast names the moved tiers", () => {
    expect(list).toMatch(
      /applyLadderChange\(\s*field as TierField,\s*\(product as unknown as Record<string, unknown>\)\[field\] as string,\s*newVal,/,
    );
    expect(list).toMatch(/\.\.\.\(ladderNote \? \{ description: ladderNote \} : \{\}\)/);
  });
});
