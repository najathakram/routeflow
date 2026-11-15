import * as fs from "fs";
import * as path from "path";

/**
 * SA-1153 (W-989 PR-2, round 3): the STRUCTURAL pin on every read of the discount mode. Replaces pin 1b of
 * `common/discount-tax-base.pin.spec.ts` (a one-file count of `applyOrderDerivedTaxRate` calls).
 *
 * It is an ORDERED PER-FILE TABLE OF CALL TEXT, not a count: a count misses an argument swap (`discountModeOf(inv)` ->
 * `discountModeOf(order)`) and two opposite swaps in one file (the invoices service holds both calls).
 *
 *   - Scope: every non-test `.ts`, `.tsx`, `.mjs`, `.cjs` and `.js` under `apps/` (which holds `apps/api/scripts/`) and `scripts/`.
 *     Excluded: `node_modules`, `dist`, dot-directories (`.next`, `.turbo`, `.jest-cache`), specs, tests and `__tests__`.
 *   - Tokens: `discountModeOf(`, `newDocumentDiscountMode(`, `discountTaxBaseOf(` and the bare identifier `DISCOUNT_PRE_TAX_FROM`.
 *     Comments are stripped first (the SA-1141 comment lines are not sites). Each entry is the call from its name to its matching
 *     close paren, whitespace collapsed; a bare-identifier read (an import, a destructure, a member read) is its own name.
 *   - It fails on: a file with a hit that is not in the table; a table file with no hits; any entry added, removed, reordered or
 *     changed. A builder who adds a site edits `MODE_SITES` in the same commit; the reviewer then asks which row of SA-1153 covers it.
 *   - It bites: the self-test runs the extractor over three planted sources (a swap, an argument change, a paired swap in one file).
 *
 * Which row of SA-1153 covers which entry is in the PR body's case table; the behavioural reds are in the `*.mode-sites*.spec.ts`
 * files, the generation-sites spec and the estimates / orders `*discount-mode-sites.spec.ts`.
 */
const ROOT = path.resolve(__dirname, "../../../..");
const SCOPE_ROOTS = ["apps", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__"]);
const SOURCE = /\.(ts|tsx|mjs|cjs|js)$/;
const TEST_FILE = /\.(spec|test)\.(ts|tsx|mjs|cjs|js)$/;
const TOKENS = [
  "discountModeOf(",
  "newDocumentDiscountMode(",
  "discountTaxBaseOf(",
  "DISCOUNT_PRE_TAX_FROM",
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), out);
    } else if (SOURCE.test(e.name) && !TEST_FILE.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

/** Strips `//` and block comments, leaving string, template and regex literals alone. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let prevSignificant = "";
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      prevSignificant = c;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < n && !(src[j] === "`" && depth === 0)) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "$" && src[j + 1] === "{") {
          depth++;
          j += 2;
        } else if (src[j] === "}" && depth > 0) {
          depth--;
          j++;
        } else j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prevSignificant = "`";
      continue;
    }
    if (c === "/" && /[(,=:[!&|?{};]/.test(prevSignificant || "(")) {
      // a regex literal
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n" && (src[j] !== "/" || inClass)) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prevSignificant = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out;
}

/** The ordered text of every mode call / read in `src` (comments stripped), whitespace collapsed. */
function modeCallsIn(src: string): string[] {
  if (!TOKENS.some((t) => src.includes(t))) return [];
  const code = stripComments(src);
  const hits: Array<{ at: number; text: string }> = [];
  const re =
    /(?<![\w$])(discountModeOf|newDocumentDiscountMode|discountTaxBaseOf)\(|(?<![\w$])DISCOUNT_PRE_TAX_FROM(?![\w$])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1]) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < code.length && depth > 0; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")") depth--;
      }
      hits.push({ at: m.index, text: code.slice(m.index, i) });
    } else hits.push({ at: m.index, text: "DISCOUNT_PRE_TAX_FROM" });
  }
  return hits
    .sort((a, b) => a.at - b.at)
    .map((h) =>
      h.text
        .replace(/\s+/g, " ") // whitespace collapsed
        .replace(/\( /g, "(") // a Prettier reflow (a break after `(`, a trailing comma before `)`) is not a change
        .replace(/,? \)/g, ")")
        .trim(),
    );
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

/** file -> its ordered mode call text, for every file in scope that has a hit. */
function scan(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const r of SCOPE_ROOTS) {
    for (const f of walk(path.join(ROOT, r))) {
      const calls = modeCallsIn(fs.readFileSync(f, "utf8"));
      if (calls.length > 0) found[rel(f)] = calls;
    }
  }
  return found;
}

/** SA-1153: every mode site, in source order, one key per file. See the PR body's case table for the row each entry belongs to. */
const MODE_SITES: Record<string, string[]> = {
  "apps/api/scripts/report-b1043-stale-tax-state.mjs": [
    "DISCOUNT_PRE_TAX_FROM",
    "discountTaxBaseOf({ createdAt: new Date(at) }, from)",
  ],
  "apps/api/scripts/report-standard-refund-tax-shortfall.mjs": [
    "DISCOUNT_PRE_TAX_FROM",
    "DISCOUNT_PRE_TAX_FROM",
    "discountTaxBaseOf({ createdAt: new Date(inv.orderCreatedAt ?? inv.createdAt) }, DISCOUNT_PRE_TAX_FROM)",
    "DISCOUNT_PRE_TAX_FROM",
  ],
  "apps/api/src/common/discount-tax-mode.ts": [
    "DISCOUNT_PRE_TAX_FROM",
    "discountModeOf(doc: DiscountModeDoc | null | undefined, from: Date | null = DISCOUNT_PRE_TAX_FROM)",
    "DISCOUNT_PRE_TAX_FROM",
    "discountTaxBaseOf({ createdAt: new Date(at) }, from)",
    "newDocumentDiscountMode(now: Date = new Date())",
    "discountModeOf({ createdAt: now })",
  ],
  "apps/api/src/common/testing/discount-cutover.ts": [
    "DISCOUNT_PRE_TAX_FROM",
    "discountModeOf({ createdAt: probe })",
  ],
  "apps/api/src/estimates/estimates.service.ts": [
    "newDocumentDiscountMode()",
    "discountModeOf(est)",
    "discountModeOf(est)",
  ],
  "apps/api/src/invoices/finalize-order-recompute.ts": ["discountModeOf(order)"],
  "apps/api/src/invoices/invoices.service.ts": [
    "newDocumentDiscountMode()",
    "discountModeOf(order)",
    "discountModeOf(order)",
    "discountModeOf(order)",
    "discountModeOf(order)",
    "discountModeOf(inv)",
    "discountModeOf(locked.invoice)",
    "discountModeOf(inv)",
    "newDocumentDiscountMode()",
  ],
  "apps/api/src/invoices/locked-invoice-edit.ts": ["discountModeOf(invoice)"],
  "apps/api/src/invoices/partial-price-follow.ts": ["discountModeOf(order)"],
  "apps/api/src/invoices/price-adjustment-ledger.ts": [
    "discountModeOf(inv)",
    "discountModeOf(inv)",
  ],
  "apps/api/src/invoices/stored-tax-state.ts": ["discountModeOf(invoice)"],
  "apps/api/src/order-templates/order-templates.service.ts": ["newDocumentDiscountMode()"],
  "apps/api/src/orders/order-totals.ts": ["discountModeOf(order)"],
  "apps/api/src/orders/orders.service.ts": [
    "discountModeOf(order)",
    "discountModeOf(winner)",
    "discountModeOf(winner)",
    "newDocumentDiscountMode()",
  ],
  "apps/web/lib/discount-tax-base.ts": [
    "DISCOUNT_PRE_TAX_FROM",
    "discountTaxBaseOf({ createdAt: now }, DISCOUNT_PRE_TAX_FROM)",
    "DISCOUNT_PRE_TAX_FROM",
  ],
};

describe("SA-1153: the ordered table of every discount-mode call (replaces pin 1b)", () => {
  const actual = scan();

  it("scans a real inventory (guards a silently-vacuous pin)", () => {
    expect(walk(path.join(ROOT, "apps")).length).toBeGreaterThan(1000);
    expect(Object.keys(actual).length).toBeGreaterThan(10);
  });

  it("no file outside the table reads the mode, and every table file still does", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(MODE_SITES).sort());
  });

  it.each(Object.keys(MODE_SITES))("%s: its calls are exactly the table's, in order", (file) => {
    expect(actual[file]).toEqual(MODE_SITES[file]);
  });

  describe("the pin bites (three planted sources, each must differ from its table)", () => {
    const TABLE = ["discountModeOf(order)", "newDocumentDiscountMode()"];
    const base = [
      "const a = applyOrderDerivedTaxRate(items, order, exempt, discountModeOf(order)); // the ORDER's mode",
      "const b = sumInvoiceTotals(lines, { discountBase: newDocumentDiscountMode() });",
    ];
    // comments are not sites: this commented-out call must not change the extraction
    const withComment = ["// discountModeOf(inv) is not a site", ...base].join("\n");

    it("the unplanted source matches its table (and a comment is not a site)", () => {
      expect(modeCallsIn(withComment)).toEqual(TABLE);
    });

    it("1: one swap (the first call reads the new-document mode)", () => {
      const planted = withComment.replace("discountModeOf(order)", "newDocumentDiscountMode()");
      expect(modeCallsIn(planted)).not.toEqual(TABLE);
    });

    it("2: one argument change (`discountModeOf(order)` -> `discountModeOf(inv)`)", () => {
      const planted = withComment.replace("discountModeOf(order)", "discountModeOf(inv)");
      expect(modeCallsIn(planted)).not.toEqual(TABLE);
    });

    it("3: a paired swap in ONE file (the count and the call names are unchanged; only the order moves)", () => {
      const planted = [
        "const a = applyOrderDerivedTaxRate(items, order, exempt, newDocumentDiscountMode());",
        "const b = sumInvoiceTotals(lines, { discountBase: discountModeOf(order) });",
      ].join("\n");
      const got = modeCallsIn(planted);
      expect(got).toHaveLength(TABLE.length);
      expect([...got].sort()).toEqual([...TABLE].sort()); // a count (or a set) pin would pass this
      expect(got).not.toEqual(TABLE);
    });

    it("a bare read of the constant is its own entry, and string / regex literals are not mangled", () => {
      expect(
        modeCallsIn('const u = "http://x"; const r = /a\\/b/; const t = DISCOUNT_PRE_TAX_FROM;'),
      ).toEqual(["DISCOUNT_PRE_TAX_FROM"]);
    });
  });
});
