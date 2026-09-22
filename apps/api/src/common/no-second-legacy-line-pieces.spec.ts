/**
 * Ratchet: `legacyLinePieces` (`@routeflow/pricing`) is the ONE place a boxes-null line's true
 * piece count is classified from a comparison against a source line (Senior Architect ruling,
 * #938, 2026-09-21). Its signature and evidence order are canonical — B661, B646's read path,
 * Lane B's B660/B665/B671 and the history report all import it. This walks `apps/api/src`
 * instead of asserting per-caller, so a NEW inline reimplementation fails the build rather than
 * quietly diverging (a second classifier that resolves a tie differently, skips the loose-pieces
 * guard, or omits the "source has no split either" case, would misclassify silently — exactly
 * the shape this design retires).
 *
 * Fingerprint: the algorithm's distinctive step is comparing a `qty` field against a `boxes`
 * field with an equality operator — something only the classifier itself has any reason to
 * write. A mere CALLER of `legacyLinePieces` only ever reads its `.basis`/`.pieces`/`.unknown`
 * result and never independently re-derives that comparison, so this never fires on a legitimate
 * caller. Matches both operand orders (`line.qty === source.boxes` and
 * `source.boxes === line.qty`), loose/strict/negated equality (`==`/`===`/`!=`/`!==`), and a
 * `Number(...)` wrapper on either side — but requires the two field NAMES to actually differ
 * (`a.qty === b.qty` is not the dangerous pattern; the classifier itself uses that shape too, to
 * compare `qty` against `qty`).
 *
 * Callers of `legacyLinePieces` must pass plain numbers, not `Decimal`s — the classifier's own
 * `Number()` coercion (see its header) protects IT against a stray `Decimal`, but a caller that
 * builds its OWN comparison (which this guard exists to catch) gets no such protection: a
 * `Decimal === number` comparison is always `false`, silently misclassifying every row as
 * unrelated rather than failing loudly.
 *
 * KNOWN LIMIT (not gameable by accident, gameable on purpose): a reimplementation that renames
 * its variables so neither side is literally `.qty`/`.boxes` (e.g. via an intermediate variable,
 * or destructuring) is invisible. Code review covers it.
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
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// One side: an optional `Number(` wrapper, then a `.qty` or `.boxes` property access (with an
// optional trailing `)` closing that wrapper). `[!=]==?` covers `==`/`===`/`!=`/`!==`.
const SIDE = String.raw`(?:Number\()?[\w.?]*\.(qty|boxes)\b\)?`;
const COMPARISON = new RegExp(`${SIDE}\\s*[!=]==?\\s*${SIDE}`, "g");

/** True when the text (already comment-stripped) compares a `.qty` against a `.boxes` — either
 * order — with an equality operator. A same-field comparison (`.qty` on both sides) never counts. */
function hasCrossFieldComparison(strippedText: string): boolean {
  const re = new RegExp(COMPARISON.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(strippedText)) !== null) {
    if (m[1] !== m[2]) return true;
  }
  return false;
}

describe("no second legacyLinePieces reimplementation in apps/api/src", () => {
  it("walks a non-trivial number of source files (guards against an empty scan reporting green)", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("the scanner can actually see the fingerprint (a regex matching nothing would pass vacuously)", () => {
    expect(hasCrossFieldComparison("if (line.qty === sourceLine.boxes) {")).toBe(true);
    expect(hasCrossFieldComparison("if (line.qty === source?.boxes) {")).toBe(true);
    // reversed operands
    expect(hasCrossFieldComparison("if (source.boxes === line.qty) {")).toBe(true);
    // Number()-wrapped, both sides
    expect(hasCrossFieldComparison("Number(line.qty) === Number(source.boxes)")).toBe(true);
    // loose equality and negation
    expect(hasCrossFieldComparison("line.qty == source.boxes")).toBe(true);
    expect(hasCrossFieldComparison("line.qty !== source.boxes")).toBe(true);
    // same-field comparisons are NOT the dangerous pattern — the classifier itself does this
    expect(hasCrossFieldComparison("a.qty === b.qty")).toBe(false);
    expect(hasCrossFieldComparison("a.boxes === b.boxes")).toBe(false);
    expect(hasCrossFieldComparison("const boxesLeft = line.boxes;")).toBe(false);
  });

  it("strips comments before scanning — a doc example referencing the shape doesn't self-trip", () => {
    expect(hasCrossFieldComparison(strip("// line.qty === sourceLine.boxes"))).toBe(false);
    expect(hasCrossFieldComparison(strip("/* line.qty === sourceLine.boxes */"))).toBe(false);
  });

  it("has zero files comparing qty against a source's boxes — legacyLinePieces is the only place", () => {
    const offenders = FILES.filter((f) =>
      hasCrossFieldComparison(strip(fs.readFileSync(f, "utf8"))),
    ).map((f) => path.relative(SRC_ROOT, f).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });
});
