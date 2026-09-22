/**
 * Ratchet: `legacyLinePieces` (`@routeflow/pricing`) is the ONE place a boxes-null line's true
 * piece count is classified from a comparison against a source line (Senior Architect ruling,
 * #938, 2026-09-21). Its signature and evidence order are canonical — B661, B646's read path,
 * Lane B's B660/B665/B671 and the history report all import it. This walks `apps/api/src`
 * instead of asserting per-caller, so a NEW inline reimplementation fails the build rather than
 * quietly diverging (a second classifier that resolves a tie differently, or omits the "source
 * has no split either" case, would misclassify silently — exactly the shape this design retires).
 *
 * Fingerprint: the algorithm's distinctive step is comparing a line's `qty` against a SOURCE
 * line's `boxes` with `===` — something only the classifier itself has any reason to write. A
 * mere CALLER of `legacyLinePieces` only ever reads its `.basis`/`.pieces`/`.unknown` result and
 * never independently re-derives that comparison, so this never fires on a legitimate caller.
 *
 * KNOWN LIMIT (not gameable by accident, gameable on purpose): a reimplementation that renames
 * its variables so the comparison isn't literally `.qty === <something>.boxes` (e.g. via an
 * intermediate variable) is invisible. Code review covers it.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

const FILES = collectSourceFiles(SRC_ROOT);
// `.qty === something.boxes` — the classifier's own comparison. Comments stripped so a doc
// example referencing the shape doesn't self-trip.
const RAW_COMPARISON = /\.qty\s*===\s*[\w.?]*\.boxes\b/;
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("no second legacyLinePieces reimplementation in apps/api/src", () => {
  it("walks a non-trivial number of source files (guards against an empty scan reporting green)", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("the scanner can actually see the fingerprint (a regex matching nothing would pass vacuously)", () => {
    expect(RAW_COMPARISON.test("if (line.qty === sourceLine.boxes) {")).toBe(true);
    expect(RAW_COMPARISON.test("if (line.qty === source?.boxes) {")).toBe(true);
    expect(RAW_COMPARISON.test("// line.qty === sourceLine.boxes")).toBe(false); // stripped first
    expect(RAW_COMPARISON.test("const boxesLeft = line.boxes;")).toBe(false);
  });

  it("has zero files comparing qty against a source's boxes — legacyLinePieces is the only place", () => {
    const offenders = FILES.filter((f) =>
      RAW_COMPARISON.test(strip(fs.readFileSync(f, "utf8"))),
    ).map((f) => path.relative(SRC_ROOT, f).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });
});
