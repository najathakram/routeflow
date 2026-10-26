/**
 * Row 513 (class fix) — structural pin: a DERIVED Piece's pack split lives in ONE place.
 *
 * `normalizeBoxesPieces({ boxes: 0, pieces: N, unitsPerBox })` is how N pieces of a pack become
 * `{ qty, boxes, pieces }`. Web, mobile and the server must all read `derivedPackSplit`
 * (`unit-options.ts`); a hand-rolled copy elsewhere is how the two apps drifted apart. This counts
 * that call shape outside `packages/pricing` across `apps/` and the other packages. The count is
 * zero and may only stay zero: reach for `derivedPackSplit` instead.
 *
 * Excluded: spec/test files and node_modules/dist/.next.
 */

import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PRICING_SRC = path.resolve(__dirname);

const INLINE_PACK_SPLIT = /normalizeBoxesPieces\(\s*\{\s*boxes:\s*0\s*,\s*pieces:/;

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "dist", "coverage", ".expo"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.(spec|test)\.[tj]sx?$/.test(entry.name))
      out.push(full);
  }
  return out;
}

describe("no inline pack split outside packages/pricing (row 513)", () => {
  it("the detector sees the shapes it is meant to catch", () => {
    expect(
      INLINE_PACK_SPLIT.test("normalizeBoxesPieces({ boxes: 0, pieces: keep, unitsPerBox: n })"),
    ).toBe(true);
    expect(INLINE_PACK_SPLIT.test("normalizeBoxesPieces({\n  boxes: 0,\n  pieces: keep,\n})")).toBe(
      true,
    );
    expect(INLINE_PACK_SPLIT.test("normalizeBoxesPieces({ qty: l.qty, unitsPerBox: upb })")).toBe(
      false,
    );
  });

  it("only packages/pricing builds a boxes-0 pieces-N split", () => {
    const roots = ["apps", "packages"].map((d) => path.join(REPO_ROOT, d));
    const offenders = roots
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => collect(d))
      .filter((f) => !f.startsWith(PRICING_SRC + path.sep))
      .filter((f) => INLINE_PACK_SPLIT.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });
});
