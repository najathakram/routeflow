import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

/**
 * B1387 / B1391 (SA-1286, OP-7): count-pinned, SHRINK-ONLY inventory of two display/money smells.
 *
 * 1. A raw `.qty` rendered straight before "×" (`{it.qty} × {price}`). On a boxed line `qty` counts
 *    PIECES while `unitPrice` is the BOX price, so "36 × $18.00" reads as $648 for 3 boxes ($54.00).
 *    The one formatter is `invoiceLineQtyText` (this package); mobile estimates wrap it in
 *    `estimateLineQtyPriceText`.
 * 2. `Number(x.qty) * Number(x.unitPrice|unitCost)` in app source: a client re-derivation of a line
 *    amount (CLAUDE.md "Money discipline"). The server total / stored subtotal is the authority.
 *
 * Each pin is an exact per-file count. A NEW hit fails the build; a converted site must lower its
 * count in the same PR (an exact map, so a stale entry also fails). Tests are excluded (fixtures).
 * Sibling of no-mirrors-linepack.spec.ts.
 */
const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["apps/web", "apps/mobile"];
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { GENERATED_DIRS } = require("../../../scripts/lib/generated-dirs.cjs") as {
  GENERATED_DIRS: readonly string[];
};
const SKIP_DIRS = new Set([...GENERATED_DIRS]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST = /(\.spec\.|\.test\.|__tests__\/|\/e2e\/)/;

const RAW_QTY_BEFORE_TIMES = /(\{|\$\{)\s*(Number\()?\s*[\w.]*\.qty\s*\)?\s*\}\s*×/g;
const CLIENT_QTY_TIMES_PRICE =
  /Number\(\s*[\w.]+\.qty\s*\)\s*\*\s*Number\(\s*[\w.]+\.(?:unitPrice|unitCost)\s*\)/g;

/** Baseline at 68091399d6 minus the B1387 / B1391 conversions. Only ever shrink. */
// Raw qty: baseline 12 hits / 11 files; the mobile estimate (B1387) is converted -> 11 / 10.
// The rest are guarded non-split branches, recurring templates (qty counts boxes), a product-name
// line, and unitCost sites (another denomination, LATER).
const RAW_QTY_PIN: Record<string, number> = {
  "apps/mobile/app/(customer)/orders/[id].tsx": 1,
  "apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx": 1,
  "apps/mobile/app/(operator)/recurring-invoices/[id].tsx": 1,
  "apps/mobile/app/(operator)/returns/index.tsx": 1,
  "apps/mobile/app/(operator)/vendor-bills/[id].tsx": 1,
  "apps/mobile/app/(operator)/vendor-bills/scan.tsx": 1,
  "apps/web/app/(dashboard)/credit-notes/page.tsx": 1,
  "apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx": 1,
  "apps/web/components/BatchItemReviewModal.tsx": 2,
  "apps/web/components/PackSizeUnknownModal.tsx": 1,
};
// Client multiply: baseline 5 hits / 4 files; mobile orders list (B1391) -> 4 / 3. The two in the
// customer order detail are dead branches (subtotal is NOT NULL); vendor bills are unitCost (LATER).
const CLIENT_MULTIPLY_PIN: Record<string, number> = {
  "apps/mobile/app/(customer)/orders/[id].tsx": 2,
  "apps/mobile/app/(operator)/vendor-bills/[id].tsx": 1,
  "apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx": 1,
};

const rel = (f: string) => relative(REPO_ROOT, f).split(sep).join("/");
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
function scanned(): string[] {
  return SCAN_ROOTS.flatMap((root) => {
    const full = join(REPO_ROOT, root);
    if (!existsSync(full)) throw new Error(`no-raw-qty scan root is missing: ${root}`);
    return walk(full).filter((f) => SOURCE.test(f) && !TEST.test(rel(f)));
  });
}
function counts(re: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of scanned()) {
    const n = readFileSync(file, "utf8").match(re)?.length ?? 0;
    if (n > 0) out[rel(file)] = n;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

describe("no raw qty beside a price (B1387, B1391, SA-1286)", () => {
  it("raw `{x.qty} ×` hits match the pin exactly (shrink-only)", () => {
    expect(counts(RAW_QTY_BEFORE_TIMES)).toEqual(RAW_QTY_PIN);
  });

  it("client `Number(qty) * Number(unitPrice|unitCost)` hits match the pin exactly (shrink-only)", () => {
    expect(counts(CLIENT_QTY_TIMES_PRICE)).toEqual(CLIENT_MULTIPLY_PIN);
  });

  it.each([
    ["{it.qty} × {fmtCurrency(it.unitPrice)}", 1],
    ["{Number(li.qty)} × {fmt(li.unitPrice)}", 1],
    ["`${item.qty} × ${price}`", 1],
    ["{estimateLineQtyPriceText(it, fmtCurrency)}", 0],
    ["{invoiceLineQtyText(item)} × {price}", 0],
  ])("anti-vacuity: the raw-qty detector sees %s -> %i", (text, n) => {
    expect(text.match(RAW_QTY_BEFORE_TIMES)?.length ?? 0).toBe(n);
  });

  it.each([
    ["Number(i.qty) * Number(i.unitPrice)", 1],
    ["Number(li.qty) * Number(li.unitCost)", 1],
    ["Number(order.total)", 0],
  ])("anti-vacuity: the multiply detector sees %s -> %i", (text, n) => {
    expect(text.match(CLIENT_QTY_TIMES_PRICE)?.length ?? 0).toBe(n);
  });
});
