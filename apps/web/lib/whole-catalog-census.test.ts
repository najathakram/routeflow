/**
 * @jest-environment node
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

/**
 * P-64 census: every whole-catalog read (`limit: 0`, the server's fetch-all sentinel, capped at 10,000 rows
 * with one presigned image URL per row) in the web app code. A new one fails this test. The 15 call sites
 * below are known and owned by other work (P-09, P-10, P-21); this test only counts them, it fixes none.
 * Tests and comments are not counted. The numbers are CEILINGS, not exact counts: a site removed by another
 * PR never turns this test red (that made it order-dependent on merge), and the lower number can be written
 * in at any later time.
 */
const WEB_ROOT = join(__dirname, "..");
const SCANNED = ["app", "lib", "components"];
const SKIP_DIR = new Set(["node_modules", ".next", "__tests__"]);
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;
const WHOLE_CATALOG = /\blimit:\s*0(?![\w.])/g;

/** path (posix, from apps/web) -> number of `limit: 0` code occurrences. */
const KNOWN: Record<string, number> = {
  "app/(dashboard)/inventory/_components/PurchaseOrdersCreateModal.tsx": 1,
  "app/(dashboard)/products/[id]/page.tsx": 1,
  "app/(dashboard)/promotions/page.tsx": 2,
  "app/(dashboard)/purchase-orders/page.tsx": 1,
  "app/(dashboard)/purchase-orders/[id]/PurchaseOrderDetail.tsx": 1,
  "app/(dashboard)/suppliers/page.tsx": 1,
  "app/buyer/portal/[seller]/_components/ReorderReviewSheet.tsx": 1,
  "app/buyer/portal/[seller]/cart/page.tsx": 1,
  "app/buyer/portal/[seller]/orders/[id]/page.tsx": 2,
  "components/AssignProductsModal.tsx": 1,
  "components/GroupAsVariantsModal.tsx": 1,
  "components/InlineCreateProductModal.tsx": 1,
  "components/ProductCreateModal.tsx": 1,
};

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIR.has(name)) walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !TEST_FILE.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Block and line comments become blanks (same length of lines kept), so a `limit: 0` in prose never counts. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function censusOf(files: string[]): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of files) {
    const hits = stripComments(readFileSync(file, "utf8")).match(WHOLE_CATALOG);
    if (hits) found[relative(WEB_ROOT, file).split(sep).join("/")] = hits.length;
  }
  return found;
}

describe("whole-catalog reads (limit: 0) in apps/web", () => {
  const files = SCANNED.flatMap((d) => walk(join(WEB_ROOT, d), []));
  const scanned = files.length;
  const found = censusOf(files);

  it("has no whole-catalog read beyond the known ones", () => {
    const extra = Object.entries(found)
      .filter(([file, n]) => n > (KNOWN[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} found, ${KNOWN[file] ?? 0} allowed`);
    if (extra.length > 0) {
      throw new Error(
        `New whole-catalog read (limit: 0) in:\n  ${extra.join("\n  ")}\n` +
          `A whole-catalog read pulls up to 10,000 products with one image URL each. ` +
          `Use the by-ids read or a paged read instead.`,
      );
    }
  });

  it("is at or below the known ceiling of 15 call lines in 13 files", () => {
    expect(Object.values(found).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15);
    expect(Object.keys(found).length).toBeLessThanOrEqual(13);
  });

  it("scans the real app (vacuity guard: more than 1,000 source files)", () => {
    expect(scanned).toBeGreaterThan(1000);
  });
});
