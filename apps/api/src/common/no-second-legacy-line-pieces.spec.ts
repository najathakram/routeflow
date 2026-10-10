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

/**
 * B661 widening: the SECOND anti-pattern this design retires — a box-unaware qty multiplied by a
 * pack size (`qty * unitsPerBox`, `qty * upb`, `Number(x.unitsPerBox)`, the `split ? ... : qty *
 * upb : qty` ternary) OUTSIDE `regulatedUnitBasis` (`@routeflow/pricing`), the ONE place this
 * design still allows it — inside `writeSaleEntries`, at write time, against a snapshot pack.
 * ANY new match fails the build. An ALLOWLIST below names every site that already did this before
 * B661 (Senior Architect ruling 2026-09-21). B679 (SA-144b, 2026-09-24) converted the four sites
 * CONFIRMED to feed a LINE's own categoryTaxAmount snapshot — orders.service.ts's create(), both
 * invoices.service.ts sites, and the shared linePieceQty helper. Of what's left, only
 * orders.service.ts's three updateOrderItems() sites are confirmed NOT category tax (traced to
 * resolveBuyerLinePrice's promo threshold instead). manual-invoice-lines.ts and
 * order-templates.service.ts were NOT traced by B679 — they may still derive a tax (or other
 * money) basis inline, the same bug class, just not yet investigated. Each
 * allowlisted file carries a `B661-sweep` comment tag at every site (for a human to find) AND an
 * exact match-COUNT pin below (the actual enforcement) — so the allowlist can only ever SHRINK: a
 * stale count (converted a site but forgot to lower its number here) fails exactly like a NEW,
 * unlisted match would.
 */
describe("no second box-unaware qty*pack multiplication in apps/api/src (B661)", () => {
  const QTY_SIDE = String.raw`(?:Number\()?[\w.]*\bqty\b\)?`;
  const PACK_SIDE = String.raw`(?:Number\()?[\w.]*(?:unitsPerBox\w*|upb\w*|\bpack\b)\)?`;
  const MULTIPLY = new RegExp(
    `(?:${QTY_SIDE}\\s*\\*\\s*${PACK_SIDE}|${PACK_SIDE}\\s*\\*\\s*${QTY_SIDE})`,
    "g",
  );

  function multiplyMatchCount(strippedText: string): number {
    const re = new RegExp(MULTIPLY.source, "g");
    return (strippedText.match(re) ?? []).length;
  }

  // B661 sweep, follow-up. B679 converted the four sites CONFIRMED to feed
  // computeCategoryTax's unitBasisQty (orders.service.ts's create(), both
  // invoices.service.ts sites, and the shared linePieceQty helper) to regulatedUnitBasis —
  // see line-piece-qty.ts, orders.service.ts's create(), and invoices.service.ts's update()/
  // applyPriceAdjustment(). The remaining updateOrderItems() sites are CONFIRMED NOT category tax:
  // they feed resolveBuyerLinePrice's QTY_BREAK/BUY_N_GET_M promo threshold for pack lines
  // (B789's stamping-rule scope, not this one). manual-invoice-lines.ts and
  // order-templates.service.ts below were NOT traced by B679 — still an open question whether
  // either feeds a tax/money basis the same way; a candidate follow-up, not this PR.
  //
  // B776 round-4 prefactor (SA-124h): updateOrderItems' replaceAll per-item build moved verbatim
  // to orders/replace-all-line-build.ts — same multiplication, same B661-sweep tag, only
  // relocated. orders.service.ts's three updateOrderItems() sites -> 2.
  const ALLOWLIST: { file: string; count: number }[] = [
    { file: "orders/orders.service.ts", count: 2 }, // updateOrderItems() ×2 (promo threshold, B789)
    { file: "orders/replace-all-line-build.ts", count: 1 }, // updateOrderItems' replaceAll rebuild
    { file: "invoices/manual-invoice-lines.ts", count: 1 }, // buildManualInvoiceLines()
    { file: "order-templates/order-templates.service.ts", count: 1 }, // createOrderFromTemplate()
    { file: "returns/inline-returns-quote.service.ts", count: 1 }, // fetchMatchingSet()
    { file: "returns/inline-returns-pricing.ts", count: 1 }, // returnRequestPieces() — found by
    // running this very scan before the tag/count were added (2026-09-21); not in the original
    // manual audit.
  ];

  it("the scanner can actually see the multiply fingerprint (a regex matching nothing would pass vacuously)", () => {
    expect(multiplyMatchCount("qty * upb")).toBe(1);
    expect(multiplyMatchCount("item.qty * upb")).toBe(1);
    expect(multiplyMatchCount("upb > 1 ? qty * upb : qty")).toBe(1);
    expect(multiplyMatchCount("split ? split.qty : upb > 1 ? item.qty * upb : item.qty")).toBe(1);
    expect(multiplyMatchCount("qty * unitsPerBoxNum")).toBe(1);
    expect(multiplyMatchCount("Number(li.qty) * Number(product.unitsPerBox)")).toBe(1);
    expect(multiplyMatchCount("upbForPieces * qty")).toBe(1); // reversed operand order
    // NOT the dangerous pattern: "qtyPieces" is a whole different identifier, not `.qty`/`qty`.
    expect(multiplyMatchCount("const qtyPieces = boxes != null ? qty : upb")).toBe(0);
    // NOT the dangerous pattern: "package"/"packAtSale" are not the bare word "pack".
    expect(multiplyMatchCount("qty * packageWeight")).toBe(0);
    expect(multiplyMatchCount("qty * packAtSale")).toBe(0); // B661's OWN allowed write-time path
  });

  it("strips comments before scanning — a doc example referencing the shape doesn't self-trip", () => {
    expect(multiplyMatchCount(strip("// qty * upb"))).toBe(0);
    expect(multiplyMatchCount(strip("/* qty * upb */"))).toBe(0);
  });

  it("every allowlisted file still carries at least one B661-sweep tag comment (catches a site moving without its tag)", () => {
    for (const { file } of ALLOWLIST) {
      const text = fs.readFileSync(path.join(SRC_ROOT, file), "utf8");
      expect(text.includes("B661-sweep")).toBe(true);
    }
  });

  it("every allowlisted file's match count is EXACTLY what's pinned — never higher (a new site), never lower (a stale, shrunk entry)", () => {
    for (const { file, count } of ALLOWLIST) {
      const text = strip(fs.readFileSync(path.join(SRC_ROOT, file), "utf8"));
      expect({ file, count: multiplyMatchCount(text) }).toEqual({ file, count });
    }
  });

  it("no file OUTSIDE the allowlist has this multiplication — a new site fails the build, not just a changed one", () => {
    const allowedFiles = new Set(ALLOWLIST.map((a) => a.file));
    const offenders = FILES.filter((f) => {
      const rel = path.relative(SRC_ROOT, f).replace(/\\/g, "/");
      if (allowedFiles.has(rel)) return false;
      return multiplyMatchCount(strip(fs.readFileSync(f, "utf8"))) > 0;
    }).map((f) => path.relative(SRC_ROOT, f).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });
});
