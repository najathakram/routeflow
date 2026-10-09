/**
 * B1043 (SA-742r2 INV-A, G4) — the pin on the ONE invoice-totals formula.
 *
 * The total of an invoice is `roundMoney(subtotal - discount + shipping + tax)`, and the place that
 * computes it is `sumInvoiceTotals` in `@routeflow/pricing` (`packages/pricing/src/invoice-totals.ts`).
 * Five server writers and the mobile builder each carried an inline copy; the header-only PATCH's copy
 * forgot the regulated levy and the exempt customer (B1043). This spec fails the build when a NEW inline
 * copy of the formula appears in production source of the api, the mobile lib or the web app/lib.
 *
 * The predicate is `roundMoney(<…subtotal> - <…discount>`: the head of every copy found. Each allowlisted
 * file is a KNOWN, bug-tracked exception; an allowlist entry that no longer matches anything is itself an
 * error (L-202: a scan or an allowance that matches nothing proves nothing), so the list shrinks as the
 * exceptions are fixed.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** `roundMoney(subtotal - discount`, `roundMoney(a.subtotal - b.invDiscount`, … */
export const INLINE_TOTAL = /roundMoney\([\w.]*[sS]ubtotal\s*-\s*[\w.]*[dD]iscount/;

/** Production source roots (relative to the repo root). packages/pricing is the ONE home, never scanned. */
const SCAN_ROOTS = ["apps/api/src", "apps/mobile/lib", "apps/web/app", "apps/web/lib"];

const INLINE_TOTAL_ALL = new RegExp(INLINE_TOTAL.source, "g");

/**
 * Known inline copies: the EXACT number of matches pinned per file, with the bug that retires it. A new copy
 * inside an allowlisted file changes the count and fails; zero matches is an error (retire the entry).
 */
const ALLOWLIST: Record<string, { count: number; why: string }> = {
  "apps/api/src/invoices/price-adjustment-ledger.ts": {
    count: 1,
    why: "totalsFromLines: the exempt asymmetry (SA-734 A4, bug r186); lands with the B297 PR3 lane",
  },
  "apps/api/src/estimates/estimates.service.ts": {
    count: 1,
    why: "estimate create total from the dto taxAmount (B395 -> SA-761a T-3)",
  },
  "apps/mobile/lib/invoice-totals.ts": {
    count: 1,
    why: "mobile own computeInvoiceTotals (B1028): a thin adapter over @routeflow/pricing in INV-B",
  },
  "apps/mobile/lib/run-money.ts": { count: 3, why: "run settlement money (B810 -> SA-761a T-4b)" },
};

const SOURCE = /\.[cm]?[tj]sx?$/;
const NOT_PRODUCTION = /\.(spec|test)\.[cm]?[tj]sx?$|\.d\.ts$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "__tests__",
  "e2e",
  ".expo",
  "coverage",
]);

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (SOURCE.test(e.name) && !NOT_PRODUCTION.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
}

/** Source with block and line comments blanked, so prose that quotes the formula never counts. */
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));

/** Inline-formula match count per file under `roots` (relative to `base`); files with none are omitted. */
export function inlineTotalCounts(base: string, roots: string[]): Record<string, number> {
  const files: string[] = [];
  for (const r of roots) walk(path.join(base, r), files);
  const out: Record<string, number> = {};
  for (const f of files.sort()) {
    const n = (stripComments(fs.readFileSync(f, "utf8")).match(INLINE_TOTAL_ALL) ?? []).length;
    if (n > 0) out[path.relative(base, f).split(path.sep).join("/")] = n;
  }
  return out;
}

describe("B1043 / G4 — one invoice total formula (sumInvoiceTotals)", () => {
  const hits = inlineTotalCounts(REPO_ROOT, SCAN_ROOTS);

  it("scans a non-trivial number of production files (an empty scan must not read as green)", () => {
    const files: string[] = [];
    for (const r of SCAN_ROOTS) walk(path.join(REPO_ROOT, r), files);
    expect(files.length).toBeGreaterThan(300);
  });

  it("no production file outside the allowlist carries an inline copy of the total formula", () => {
    expect(Object.keys(hits).filter((f) => !(f in ALLOWLIST))).toEqual([]);
  });

  it("every allowlisted file carries EXACTLY its pinned number of copies (a new copy fails; zero is an error: retire the entry)", () => {
    for (const [f, { count }] of Object.entries(ALLOWLIST)) {
      expect(count).toBeGreaterThan(0);
      expect({ file: f, matches: hits[f] ?? 0 }).toEqual({ file: f, matches: count });
    }
  });

  it("the allowlist names real files", () => {
    for (const f of Object.keys(ALLOWLIST)) {
      expect({ file: f, exists: fs.existsSync(path.join(REPO_ROOT, f)) }).toEqual({
        file: f,
        exists: true,
      });
    }
  });

  it("the predicate catches the shapes the five server copies used", () => {
    for (const line of [
      "const total = roundMoney(subtotal - invDiscount + shipping + taxTotal);",
      "const total = roundMoney(subtotal - discount + taxTotal);",
      "return roundMoney(t.subtotal - t.discount + ship);",
      "roundMoney(linesSubtotal - dto.discount",
    ]) {
      expect({ line, caught: INLINE_TOTAL.test(line) }).toEqual({ line, caught: true });
    }
  });

  it("self-test: one injected inline formula in a temp fixture is reported", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "one-invoice-total-"));
    try {
      const dir = path.join(tmp, "apps", "api", "src", "demo");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "clean.ts"),
        "// roundMoney(subtotal - discount) in prose only\nexport const ok = sumInvoiceTotals([], {}).total;\n",
      );
      fs.writeFileSync(
        path.join(dir, "rogue.service.ts"),
        "export const bad = (subtotal: number, invDiscount: number) =>\n  roundMoney(subtotal - invDiscount + 1);\n",
      );
      expect(inlineTotalCounts(tmp, ["apps/api/src"])).toEqual({
        "apps/api/src/demo/rogue.service.ts": 1,
      });
      // a SECOND copy in the same file is counted, so an allowlisted file cannot hide one
      fs.appendFileSync(
        path.join(dir, "rogue.service.ts"),
        "export const bad2 = (subtotal: number, discount: number) => roundMoney(subtotal - discount);\n",
      );
      expect(inlineTotalCounts(tmp, ["apps/api/src"])).toEqual({
        "apps/api/src/demo/rogue.service.ts": 2,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
