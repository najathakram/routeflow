import { readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";

/**
 * Ratchet for units_v1 step 4. A line writer that reads `product.unitsPerBox` off the LIVE product
 * decides its factor from the pack — wrong the moment a line is sold by a Case/Pallet/Piece
 * (`resolveLineUnits`, ./line-units.ts, is the one place a line's factor is decided).
 *
 * Every file below still has direct reads today (the baseline). The count may only go DOWN as
 * each site is converted to the helper; a NEW direct read in any listed file fails the build, and
 * so does a stale (too-high) baseline — lower it when you convert a site. The target is all zeros.
 *
 * Counts are taken with comments stripped, over `<something>product|prod|p|pr|src ?.unitsPerBox`.
 * Reads that are NOT line-factor derivations (a catalog display, a stock label, a report basis)
 * are still counted: convert them to the helper, or move them to a named non-line helper.
 */
const BASELINE: Record<string, number> = {
  "orders/orders.service.ts": 21,
  "invoices/invoices.service.ts": 8,
  "estimates/estimates.service.ts": 2,
  "order-templates/order-templates.service.ts": 1,
  "returns/inline-returns-quote.service.ts": 3,
  "buyer/buyer.controller.ts": 1,
  "buyer/replenishment.service.ts": 1,
  "buyer/buyer-catalog.service.ts": 3,
  "inventory/inventory.service.ts": 4,
};

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const READ = /\b(?:[A-Za-z_]*[pP]roduct|prod|p|pr|src)\??\.unitsPerBox\b/g;
const count = (rel: string) =>
  (strip(readFileSync(join(__dirname, "..", rel), "utf8")).match(READ) ?? []).length;

describe("line-units call-site ratchet (units_v1 step 4)", () => {
  it.each(Object.entries(BASELINE))(
    "%s has no MORE direct product.unitsPerBox reads than the baseline (%i)",
    (rel, baseline) => {
      const now = count(rel);
      // Both directions: a new read must not appear, and a converted site must lower the baseline.
      expect({ file: rel, reads: now }).toEqual({ file: rel, reads: baseline });
    },
  );

  it("the scanner can actually see reads (a regex that matches nothing would pass vacuously)", () => {
    expect(count("orders/orders.service.ts")).toBeGreaterThan(0);
    expect(strip("// product.unitsPerBox\nconst a = 1; /* p.unitsPerBox */")).not.toMatch(READ);
    expect("const u = product.unitsPerBox; const v = p?.unitsPerBox;".match(READ)).toHaveLength(2);
  });

  it("every file that writes order/invoice lines is in the ratchet or a known non-writer", () => {
    // A new service that reads product.unitsPerBox must be added to BASELINE (or converted).
    const listed = new Set(Object.keys(BASELINE));
    const known = new Set([
      "products/products.service.ts",
      "products/product-units.service.ts",
      "products/line-units.ts",
      "regulated/tx-report.ts",
    ]);
    const root = join(__dirname, "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")
            ? [join(dir, e.name)]
            : [],
      );
    const files = walk(root).map((f) => relative(root, f).split(sep).join("/"));
    const offenders = files.filter((f) => {
      if (listed.has(f) || known.has(f)) return false;
      return (strip(readFileSync(join(root, f), "utf8")).match(READ) ?? []).length > 0;
    });
    expect(offenders).toEqual([]);
  });
});
