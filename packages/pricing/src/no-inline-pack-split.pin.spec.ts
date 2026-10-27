/**
 * Row 513 (class fix) — structural pin: a DERIVED Piece's pack split lives in ONE place.
 *
 * `normalizeBoxesPieces({ boxes: 0, pieces: N, unitsPerBox })` (any key order, spacing, alias or namespace, with
 * `boxes` absent or 0) is how N pieces of a pack become
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

const FN = "normalizeBoxesPieces";

/** The text inside the balanced parens of each `fn(` call (spaced, chained, namespaced or aliased). */
function callBlocks(src: string): string[] {
  const names = [
    FN,
    ...[...src.matchAll(new RegExp(`${FN}\\s+as\\s+(\\w+)`, "g"))].map((m) => m[1]),
  ];
  const out: string[] = [];
  for (const name of names) {
    const open = new RegExp(`\\b${name}\\s*(?:\\?\\.\\s*)?\\(`, "g");
    for (let m = open.exec(src); m; m = open.exec(src)) {
      let depth = 1;
      let i = open.lastIndex;
      for (; i < src.length && depth > 0; i++)
        depth += src[i] === "(" ? 1 : src[i] === ")" ? -1 : 0;
      out.push(src.slice(open.lastIndex, i - 1));
    }
  }
  return out;
}

/** A pieces key with no real boxes (absent, or the literal 0) is a derived-pack split built by hand. */
function hasInlinePackSplit(src: string): boolean {
  const key = (k: string) => new RegExp(`[{,]\\s*${k}\\s*[:,}]`);
  return callBlocks(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ")).some(
    (b) => key("pieces").test(b) && (!key("boxes").test(b) || /\bboxes\s*:\s*0(?![\d.\w])/.test(b)),
  );
}

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
  it.each([
    ["the canonical shape", "normalizeBoxesPieces({ boxes: 0, pieces: keep, unitsPerBox: n })"],
    ["multi-line", "normalizeBoxesPieces({\n  boxes: 0,\n  pieces: keep,\n})"],
    ["pieces before boxes", "normalizeBoxesPieces({ pieces: n, boxes: 0, unitsPerBox: u })"],
    ["no boxes key", "normalizeBoxesPieces({ pieces: n, unitsPerBox: u })"],
    ["shorthand pieces", "normalizeBoxesPieces({ boxes: 0, pieces, unitsPerBox })"],
    ["a comment between the keys", "normalizeBoxesPieces({ boxes: 0, /* loose */ pieces: n })"],
    ["a space before the paren", "normalizeBoxesPieces ( { boxes: 0, pieces: n } )"],
    ["a namespace import", "pricing.normalizeBoxesPieces({ boxes: 0, pieces: n })"],
    ["an optional call", "pricing?.normalizeBoxesPieces?.({ boxes: 0, pieces: n })"],
    [
      "an aliased import",
      "import { normalizeBoxesPieces as nbp } from 'x';\nnbp({ boxes: 0, pieces: n });",
    ],
  ])("the detector sees %s", (_name, src) => {
    expect(hasInlinePackSplit(src)).toBe(true);
  });

  it.each([
    ["a variable that is named pieces", "normalizeBoxesPieces({ qty: pieces, unitsPerBox: upb })"],
    ["a line's own qty", "normalizeBoxesPieces({ qty: l.qty, unitsPerBox: upb })"],
    ["real boxes and pieces", "normalizeBoxesPieces({ boxes: b, pieces: p, unitsPerBox: upb })"],
    ["a boxes-only line", "normalizeBoxesPieces({ boxes: 0, qty: 3, unitsPerBox: upb })"],
    ["a mention in a comment", "// normalizeBoxesPieces({ boxes: 0, pieces: n })\nconst x = 1;"],
  ])("the detector leaves %s alone", (_name, src) => {
    expect(hasInlinePackSplit(src)).toBe(false);
  });

  it("only packages/pricing builds a boxes-0 pieces-N split", () => {
    const roots = ["apps", "packages"].map((d) => path.join(REPO_ROOT, d));
    const offenders = roots
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => collect(d))
      .filter((f) => !f.startsWith(PRICING_SRC + path.sep))
      .filter((f) => hasInlinePackSplit(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });
});
