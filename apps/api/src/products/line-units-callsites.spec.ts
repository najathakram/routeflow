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
  // SA-124g/h R1: the replaceAll rebuild is reverted to master byte-for-byte (SA-124e's HIGH 2
  // resolver — which had retired 4 of these 20 reads — is R2 scope now), restoring the original
  // 20 reads, plus ONE new read feeding `assertReplaceAllPackMatchesLive`'s live-pack guard (21).
  // Round-4 prefactor (SA-124h, absorbing origin/master's unrelated growth under the size
  // ratchet): the per-item price/data builder moved verbatim to replace-all-line-build.ts,
  // taking 5 of these reads with it — 21 -> 16.
  "orders/orders.service.ts": 15,
  // Round-4 prefactor (SA-124h): buildReplaceAllLineData, moved verbatim out of
  // orders.service.ts's replaceAll rebuild (see that file's own comment above) — same 5 reads,
  // same behavior, only relocated.
  "orders/replace-all-line-build.ts": 5,
  // B297 stack (PR3 / rows 355 / 373): the recompute and free-unit-settle bodies moved out of orders.service.ts
  // (which fell 16 -> 15), and the per-line pack / pairing helpers read the live pack ONLY to mirror the write
  // path's own denomination gate (a paired line is judged in the unit its write path would use). Reads, never
  // a new place a line's factor is decided; the count may only go down.
  "orders/buyer-edit-lines.ts": 2,
  "orders/recompute-line-category-taxes.ts": 1,
  "orders/settle-split-free-units.ts": 2,
  "orders/split-promo-group.ts": 1,
  // #2717 M3: ONE read of a COMPONENT product's pack (`p.unitsPerBox`) in buildComponentSnapshots,
  // feeding synthesizeLegacyBarcodes for a held tenant's legacy unit barcode. It is a barcode
  // synthesis input, never a line-factor decision (the line's own snapshot is planFixedComposition's
  // input). Retires if the synthesis moves to a named non-line helper.
  "orders/line-composition.ts": 1,
  // Three reads today (B717/SA-077 lowered this from 6; SA-068b's earlier note predicted 5, which
  // the hoist overtook — four reads in update()'s mapper became one). Do not read that history as
  // a forecast; what is left, and what retires each:
  //   1. buildInvoiceItemData's `li.unitsPerBox ?? li.product?.unitsPerBox` — the legacy fallback
  //      for an ORDER line that carries no snapshot. Retired by SA-078(c), which snapshots the
  //      pack on box-unaware order lines at write time so there is a real one to prefer.
  //   2. update()'s single `livePack` local — read once and passed as a PARAMETER to
  //      `resolveUpdateLinePack` (invoices/update-pack-resolution.ts reads no product at all).
  //      Retired when a sub-one-box line can no longer need new-line semantics, i.e. after
  //      SA-077(2) refuses the still-ambiguous split and every line carries a snapshot.
  //   3. `applyPriceAdjustment`'s `unitsPerBoxByProduct` map — a regulated BASIS lookup, never a
  //      line-factor decision. Retired by moving it to a named non-line helper (SA-047 shape).
  // The number may only go DOWN. The target is still zero.
  // Merge of master into #2083: item 2 moved to invoice-edit-plan.ts (SA-184) and item 3 moved to
  // price-adjustment-ledger.ts (B662), so only item 1 (buildInvoiceItemData) is left here.
  "invoices/invoices.service.ts": 1,
  "invoices/invoice-edit-plan.ts": 1, // the moved read: a NEW line's live-pack last resort (SA-077); a stored line never reads it
  // 4c-1 prefactor: create()'s line builder moved (3 reads) to:
  // B659: two direct read sites in this file (box-split branch's `item.packSnapshot ??
  // product?.unitsPerBox`, and the no-split branch's `upbForPieces` gaining the same fallback per
  // review finding 2). Verified by running the scanner's own regex directly against the file, not
  // carried forward from the stale pre-B717/B681 draft this commit was originally cut against.
  "invoices/manual-invoice-lines.ts": 2,
  "invoices/invoice-restriction-lines.ts": 1, // F-05: a READ-ONLY piece count for the sell check on an edit; never derives or stores a line pack
  // B662: `applyPriceAdjustment`'s `unitsPerBoxByProduct` lookup (item 3 above) moved here with its
  // extraction (loadPriceAdjustmentReference): still a regulated BASIS lookup, never a line factor.
  "invoices/price-adjustment-ledger.ts": 1,
  "estimates/estimates.service.ts": 1,
  "order-templates/order-templates.service.ts": 1,
  // B646: generation is a NEW sale, so the recurring generator reads the LIVE pack at generation time (the
  // Senior Architect buildLine contract) to store a boxed template line in pieces; the split lives in
  // recurring-invoices/recurring-line-split.ts.
  "recurring-invoices/recurring-invoices.service.ts": 1,
  "returns/inline-returns-quote.service.ts": 3,
  "buyer/buyer.controller.ts": 1,
  "buyer/replenishment.service.ts": 1,
  "buyer/buyer-catalog.service.ts": 3,
  // 3 since the count line's in-tx product read became `live` (SA-767 L-2.4 A): upsertStockCountLine reads
  // `live.unitsPerBox` to rebuild the boxes/pieces split (a count quantity, not a line factor).
  "inventory/inventory.service.ts": 3,
  // SA-079: loadProductPackNow's ONE read is classifySaleAxis's boxed-GATE fallback for a
  // box-unaware line with no unitsPerBox snapshot of its own — it derives no line factor,
  // quantity or price. But it is not inert: its output decides whether a return's SALE row is
  // PARKED or COUNTED, which is exactly the figure a filing later sums — a wrong answer here
  // changes what a period reports even though it changes no quantity or price anywhere. Count-
  // pinned rather than NON_WRITERS-exempted (SA-047/SA-068b shape) because it is temporary: it
  // goes to 0 when SA-078(c) snapshots unitsPerBox on box-unaware ORDER lines and this fallback
  // becomes unreachable. Never raise this again after that.
  "regulated/regulated-ledger.service.ts": 1,
  // B673: approveNextDelivery reads the LIVE pack ONLY for an ADD_ITEM that carries a filed
  // box split (a driver's door add), to compare it with the pack the request was filed at —
  // (qty - pieces) / boxes. It derives no line factor, quantity or price: a match hands the
  // filed split to create() unchanged, a mismatch REFUSES naming both packs. CHANGE_QTY never
  // reaches it (B655's SA ruling). Count-pinned rather than exempted, so a second read here
  // still fails the build.
  "orders/change-requests.service.ts": 1,
  // Row 497 (#3437): the buyer full-replace keeps a staff price override only while the line's OWN pack snapshot
  // still equals the LIVE pack, so it reads the live pack twice (the batch filter's productMap lookup and the
  // per-line keptOverrideFor guard) purely to COMPARE. It derives no line factor, quantity or price and writes no
  // pack. Count-pinned rather than exempted, so a third read still fails the build. (Train S2: this ratchet
  // landed on master after #3437 branched.)
  "orders/buyer-replace-keep.ts": 2,
};

// Files that legitimately read a product's pack and are not line writers.
const NON_WRITERS = new Set([
  "products/products.service.ts",
  "products/product-units.service.ts",
  "products/line-units.ts",
  "orders/unit-line-build.ts", // copies unit/unitsPerBox into the ladder base; never derives a factor
  // H3b (#3435): ladderProduct copies the live unitsPerBox into the price-ladder input the override decision
  // reads (the same base as unit-line-build); it derives no line factor and writes no pack. (Train M1.)
  "invoices/invoice-line-override.ts",
  "regulated/tx-report.ts",
  // B661: packAtSaleByProduct's `p.unitsPerBox` read is a write-time SNAPSHOT for the ledger's
  // regulatedUnitBasis, not a line-factor decision — never re-read later to reclassify an old row.
  "invoices/pack-at-sale.ts",
  // B665: the shared pack resolver reads the live pack ONLY to notice that a boxed product's line is
  // ambiguous (no split); the pieces-per-unit itself comes from legacyLinePieces, never from this read.
  "common/line-pack-factors.ts",
  // B743: reads the live product ONLY to notice that a vendor-bill line's OWN packSize is missing —
  // the conversion itself (lineInventoryDelta) still reads packSize from the bill line alone; this
  // module never supplies the missing number, it only decides whether to ask.
  "vendor-bills/bill-line-pack.ts",
  // #2118: read-only analytics, writes no line. Reads the live pack for the product DTO's
  // "at the current pack" display and as salePackOf's GATE (is a no-snapshot line on a product
  // boxed today?) — never a multiplier; selling units come from each line's own snapshot.
  "sales-facts/product-insights.service.ts",
  // B948: reads the live pack ONLY as the LAST fallback to express an inline return's PIECES on a legacy
  // line's own qty axis (the same fallback order the inline pricing uses); writes no line, snapshots nothing.
  "credit-notes/line-credit-headroom.ts",
  // Price-history popover (step 2A): read-only. Reads the live pack ONLY as salePackOf's GATE for a
  // no-snapshot line (is the product boxed today?), exactly as product-insights does; every row's unit
  // and pack come from the line's own snapshot. Writes no line.
  "customers/customer-price-history.service.ts",
  // "Usually buys" / "Order again" (staff New Order): read-only. Passes the product's CURRENT catalog columns
  // (incl. unitsPerBox) through to the order builder, which prices every added line through its own add-line
  // path; a past line's own snapshot (unitsPerBox/unitLabel) is returned as ordered. Writes no line.
  "customers/customer-order-suggestions.service.ts",
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
