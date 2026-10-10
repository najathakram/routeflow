import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-105 LOW: `listPrice` is the PACK's own tier-1 price — comparing a unit-sold line's price
 * against it to decide the "was $X" strikethrough is meaningless (a $2 Piece would render "was
 * $24.00 $2.00 / Piece", and a genuinely tier-discounted Case would show no strikethrough at
 * all, since a Case's price is never smaller than the pack's list price). Mobile Jest has no
 * RN renderer, so this is a source pin, matching this repo's convention for component-embedded
 * logic that isn't worth extracting into lib on its own (`edit-items-scan-price.test.ts`, etc.).
 */
describe("ProductRow suppresses the was-price marker on a unit-sold line (SA-105 LOW)", () => {
  const src = readFileSync(join(__dirname, "..", "components", "ProductRow.tsx"), "utf8");

  it("isSpecial is false whenever unitLabel is set, regardless of the pack's listPrice", () => {
    expect(src).toMatch(/const isSpecial = !unitLabel && price < listPrice - 0\.0001;/);
  });
});
