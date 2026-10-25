/**
 * SA-840 (B704 / #1477), the class guard: a credit or refund of an invoice-line SLICE is priced in ONE place,
 * `refundableLineShare` (@routeflow/pricing), which carries the line's charged tax shares, its invoice-discount share and
 * exact-cent conservation. A second slice formula in `returns/` or `credit-notes/` is how master refunded NET only: the
 * pooled `qty x billedSubtotal / billed` average ignored the tax the invoice charged.
 *
 * This spec fails, naming the file, when the code (comments ignored) of any file under `returns/` or `credit-notes/`
 * contains slice math (`... billedSubtotal) / billed`, or `creditedThrough(`) outside the allowlist below. The allowlist
 * only shrinks: the inline returns pricer until it migrates onto the helper (a follow-up row), and
 * `planProductRefund`'s qty-fill bound, whose `price` is a refusal bound and no longer a money source.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(__dirname, "..");
const ROOTS = ["returns", "credit-notes"].map((d) => path.join(SRC, d));

/** Why each allowlisted file may still hold slice math. Never add a file: move it onto the helper. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  "returns/inline-returns-pricing.ts":
    "inline pricer: migrates to the helper in a follow-up row (SA-840 G3/G8)",
  "credit-notes/line-credit-headroom.ts":
    "planProductRefund's refusal bound: not a money source since SA-840",
};

/** Code with line and block comments blanked out (a comment may explain the old formula; code may not). */
export function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

const SLICE_MATH = [/billedSubtotal\)\s*\/\s*billed/, /\bcreditedThrough\(/];

/** True when the code of `text` holds a slice-pricing expression. */
export function hasSliceMath(text: string): boolean {
  const code = codeOnly(text);
  return SLICE_MATH.some((re) => re.test(code));
}

function collect(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("SA-840: a return/credit slice of an invoice line has ONE price source", () => {
  const files = ROOTS.flatMap((root) => collect(root));
  const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

  it("walks a non-trivial number of source files (an empty scan must not report green)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("the detector trips on the pooled average and on a creditedThrough slice, and ignores a comment", () => {
    expect(
      hasSliceMath(
        "amount += roundMoney((Math.min(axis.returned, billed) * billedSubtotal) / billed);",
      ),
    ).toBe(true);
    expect(hasSliceMath("const t = creditedThrough(line.subtotal, n, line.qty);")).toBe(true);
    expect(hasSliceMath("// was (min * billedSubtotal) / billed\n/* creditedThrough( */")).toBe(
      false,
    );
  });

  it("every allowlisted file exists and still needs its entry (a stale row must be deleted)", () => {
    for (const file of Object.keys(ALLOWLIST)) {
      const abs = path.join(SRC, file);
      expect(fs.existsSync(abs)).toBe(true);
      expect(hasSliceMath(fs.readFileSync(abs, "utf8"))).toBe(true);
    }
  });

  it("REG-B704 no file outside the allowlist holds slice-pricing math", () => {
    // wrong today: returns/returns.service.ts prices a return as (min(returned, billed) * billedSubtotal) / billed
    const stray = files
      .filter((f) => !(rel(f) in ALLOWLIST))
      .filter((f) => hasSliceMath(fs.readFileSync(f, "utf8")))
      .map(rel);
    expect(stray).toEqual([]);
  });

  it("REG-B704 the standard-return pricer is wired to the shared helper", () => {
    // wrong today: standard-refund-pricing.ts does not exist and returns.service.ts prices the slice itself
    const read = (file: string) => codeOnly(fs.readFileSync(path.join(SRC, file), "utf8"));
    expect(read("returns/standard-refund-pricing.ts")).toMatch(/\brefundableProductPoolShare\(/);
    expect(read("returns/returns.service.ts")).toMatch(/from "\.\/standard-refund-pricing"/);
  });
});
