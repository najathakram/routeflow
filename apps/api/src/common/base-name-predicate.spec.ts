import * as fs from "fs";
import * as path from "path";

/**
 * Row 621 / SA-971 inventory pin: "is this label the base unit's name" is ONE predicate, pricing's `namesBase`
 * (packages/pricing unit-levels.ts). A hand-written copy (`norm(x) === norm(baseLabelOf(p)) || ... PIECE_LABEL`) drifts
 * from it, so any API source file that restates it goes red here. A new legitimate use of PIECE_LABEL on its own (not
 * as a base-name test) goes in ALLOWED with the reason.
 */
const SRC = path.join(__dirname, "..");

/** `norm(...) === norm(PIECE_LABEL)` or `=== norm(baseLabelOf(...))`: the shapes the copies took. */
const HAND_WRITTEN = /===\s*(?:norm|unitNameKey)\(\s*(?:PIECE_LABEL|baseLabelOf\()/;

/** file (relative to src) -> why a hit there is not a base-name test. */
const ALLOWED: Record<string, string> = {
  "products/line-units.ts":
    "classifies a stored label as the 1-piece KIND (the legacy Piece word or factor 1), not 'is it this product's base name'",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

export function handWrittenBaseNameChecks(files: string[]): string[] {
  return files
    .filter((f) => HAND_WRITTEN.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
    .filter((rel) => !(rel in ALLOWED));
}

describe("one base-name predicate (row 621)", () => {
  it("no API source restates namesBase by hand", () => {
    expect(handWrittenBaseNameChecks(walk(SRC))).toEqual([]);
  });

  it("the pin sees the shapes the copies took", () => {
    expect(HAND_WRITTEN.test("l === norm(PIECE_LABEL)")).toBe(true);
    expect(HAND_WRITTEN.test("norm(l) === norm(baseLabelOf(product))")).toBe(true);
    expect(HAND_WRITTEN.test("namesBase(product, l)")).toBe(false);
  });

  it("every ALLOWED entry still exists and still has a hit (a stale entry is deleted)", () => {
    for (const rel of Object.keys(ALLOWED)) {
      const src = fs.readFileSync(path.join(SRC, rel), "utf8");
      expect(HAND_WRITTEN.test(src)).toBe(true);
    }
  });
});
