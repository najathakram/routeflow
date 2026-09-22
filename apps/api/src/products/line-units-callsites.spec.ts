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
 * Counted, with comments stripped: a read off a LIVE product (`product.`, `p.`, `prod.`,
 * `xProduct.`, a `map.get(id)!.` lookup) or a destructure from one. Reads off a LINE snapshot
 * (`src.`, `li.`, `existing.`) are the ones the design WANTS and are not counted. Reads that are
 * not line-factor derivations (a catalog display, a stock label, a report basis) are still
 * counted: convert them to the helper, or move them to a named non-line helper.
 *
 * KNOWN LIMIT (not gameable by accident, gameable on purpose): a product held in an unusually
 * named variable (`row.unitsPerBox`) is invisible. Code review + the 4b/4c conversion PRs cover it.
 */
const BASELINE: Record<string, number> = {
  "orders/orders.service.ts": 20,
  // SA-068b: update() gained ONE new read — a divergence CHECK (payload's own implied pack vs
  // product.unitsPerBox, warn-only) — never a line-factor decision; the pack itself now comes
  // from packFromOwnSplit(the payload's own qty/boxes/pieces), never product.unitsPerBox. Count-
  // pinned rather than NON_WRITERS-exempted (SA-047 shape) because it is meant to be temporary:
  // SA-063's packOfStoredLine takes the live pack as a PARAMETER, so this read moves into that
  // one helper and the count returns to 5 once that lands. Never raise this again after that.
  "invoices/invoices.service.ts": 6, // 4c-1 prefactor: create()'s line builder moved (3 reads) to:
  "invoices/manual-invoice-lines.ts": 3,
  // B645: create()'s itemsData mapper read product.unitsPerBox at 3 sites (qty
  // resolve, computeLineSubtotal, and the B645 boxes/pieces/unitsPerBox snapshot
  // this fix added) — hoisted to one `productUnitsPerBox` local reused at all
  // three, so the counted baseline goes DOWN from 2 to 1 even though a 3rd
  // logical use was added.
  "estimates/estimates.service.ts": 1,
  "order-templates/order-templates.service.ts": 1,
  "returns/inline-returns-quote.service.ts": 3,
  "buyer/buyer.controller.ts": 1,
  "buyer/replenishment.service.ts": 1,
  "buyer/buyer-catalog.service.ts": 3,
  "inventory/inventory.service.ts": 4,
  // SA-079: loadProductPackNow's ONE read is classifySaleAxis's boxed-GATE fallback for a
  // box-unaware line with no unitsPerBox snapshot of its own — it derives no line factor,
  // quantity or price. But it is not inert: its output decides whether a return's SALE row is
  // PARKED or COUNTED, which is exactly the figure a filing later sums — a wrong answer here
  // changes what a period reports even though it changes no quantity or price anywhere. Count-
  // pinned rather than NON_WRITERS-exempted (SA-047/SA-068b shape) because it is temporary: it
  // goes to 0 when SA-078(c) snapshots unitsPerBox on box-unaware ORDER lines and this fallback
  // becomes unreachable. Never raise this again after that.
  "regulated/regulated-ledger.service.ts": 1,
};

// Files that legitimately read a product's pack and are not line writers.
const NON_WRITERS = new Set([
  "products/products.service.ts",
  "products/product-units.service.ts",
  "products/line-units.ts",
  "orders/unit-line-build.ts", // copies unit/unitsPerBox into the ladder base; never derives a factor
  "regulated/tx-report.ts",
  // B661: packAtSaleByProduct's `p.unitsPerBox` read is a write-time SNAPSHOT for the ledger's
  // regulatedUnitBasis, not a line-factor decision — never re-read later to reclassify an old row.
  "invoices/pack-at-sale.ts",
  // B665: the shared pack resolver reads the live pack ONLY to notice that a boxed product's line is
  // ambiguous (no split); the pieces-per-unit itself comes from legacyLinePieces, never from this read.
  "common/line-pack-factors.ts",
]);

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const PRODUCT_VAR = "(?:[A-Za-z_]*[pP]roduct|prod|p|pr)";
const READ_SOURCE = [
  `\\b${PRODUCT_VAR}\\??\\.unitsPerBox\\b`,
  "\\.get\\([^)]*\\)!?\\??\\.unitsPerBox\\b",
  `\\{[^}]*\\bunitsPerBox\\b[^}]*\\}\\s*=\\s*${PRODUCT_VAR}\\b(?!\\s*\\.)`,
].join("|");
// A fresh regex per use: a shared /g regex is stateful under .test()/toMatch.
const reads = (text: string) => strip(text).match(new RegExp(READ_SOURCE, "g")) ?? [];
const count = (rel: string) => reads(readFileSync(join(__dirname, "..", rel), "utf8")).length;

describe("line-units call-site ratchet (units_v1 step 4)", () => {
  it.each(Object.entries(BASELINE))(
    "%s has exactly the baseline number of direct product.unitsPerBox reads (%i)",
    (rel, baseline) => {
      // Both directions: a new read must not appear, and a converted site must lower the baseline.
      expect({ file: rel, reads: count(rel) }).toEqual({ file: rel, reads: baseline });
    },
  );

  it("the scanner can actually see reads (a regex that matches nothing would pass vacuously)", () => {
    expect(count("orders/orders.service.ts")).toBeGreaterThan(0);
    expect(reads("// product.unitsPerBox\nconst a = 1; /* p.unitsPerBox */")).toHaveLength(0);
    expect(reads("const u = product.unitsPerBox; const v = p?.unitsPerBox;")).toHaveLength(2);
    expect(reads("const w = productMap.get(id)!.unitsPerBox;")).toHaveLength(1);
    expect(reads("const { unitsPerBox } = product;")).toHaveLength(1);
    // Line snapshots are the reads the design wants — never counted.
    expect(
      reads("const x = src.unitsPerBox + li.unitsPerBox + existing?.unitsPerBox;"),
    ).toHaveLength(0);
  });

  it("no OTHER file reads a product's pack directly (a new line writer must use resolveLineUnits or be listed)", () => {
    const listed = new Set(Object.keys(BASELINE));
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
    const offenders = files.filter(
      (f) =>
        !listed.has(f) &&
        !NON_WRITERS.has(f) &&
        reads(readFileSync(join(root, f), "utf8")).length > 0,
    );
    expect(offenders).toEqual([]);
  });
});
