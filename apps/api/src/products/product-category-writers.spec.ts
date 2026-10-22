/**
 * Census of every Prisma write to `Product` in `apps/api/src` (static scan, no DB).
 *
 * Owner ruling: whenever ANY code path writes `Product.category` (free text), the SAME transaction calls
 * `syncCategoryLabel` (product-categories/label-writer.ts), so the product gains the INCLUDE membership
 * of an existing, unarchived label whose name matches. A product write that can set `category` and does
 * not sync is how a label silently goes stale.
 *
 * So the build fails when a file with a product write is in neither table below (a NEW writer), when a
 * HOOKED file loses a sync call or gains/loses a write, or when an EXEMPT file's write count moves (its
 * reason may no longer hold). The author then either hooks the new write or exempts it with a reason.
 *
 * Scanned: `product.create|createMany|update|updateMany|upsert(` on any client (`tx.`, `db.`,
 * `this.prisma.forTenant().`) and raw `UPDATE|INSERT INTO "Product"`. Not scanned: `*.spec.ts`, `testing/`.
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..");

const WRITE =
  /\bproduct\s*\.(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)\s*\(|(?:UPDATE|INSERT\s+INTO)\s+"Product"/g;
const SYNC = /\bsyncCategoryLabel(?:ForProducts)?\s*\(/g;

/** Files whose product writes can set `Product.category`: every one must call the sync. */
const HOOKED: Record<string, { writes: number; syncs: number; via: string }> = {
  "products/products.service.ts": {
    writes: 7,
    syncs: 3,
    via: "create (dto.category / parent's), update (dto.category / structured-subcategory mirror), importProducts (item.category)",
  },
  "products/product-families.service.ts": {
    writes: 6,
    syncs: 1,
    via: "createFamily: the family row's category (variants copy none); reactivateFamilyContainer writes isActive only (no category text moves, so no sync)",
  },
  "inventory/inventory.service.ts": {
    writes: 12,
    syncs: 1,
    via: "createVariantRowInTx: a new variant copies its parent's category",
  },
  "tracked-categories/tracked-categories.service.ts": {
    writes: 7,
    syncs: 1,
    via: "updateSubcategory rename: products mirroring the subcategory take its new name",
  },
  "import/variant-resolution.service.ts": {
    writes: 2,
    syncs: 1,
    via: "completeSetup: the confirmed free-text category",
  },
};

/** Files whose product writes can never set `Product.category` (one-line reason each). */
const EXEMPT: Record<string, { writes: number; reason: string }> = {
  "products/product-price-write.service.ts": {
    writes: 1,
    reason: "writes the five pack price columns, packAuto and priceRevision only; never category",
  },
  "units/units.service.ts": {
    writes: 3,
    reason: "a unit rename rewrites baseUnitLabel, packLabel and unit by nameKey; never category",
  },
  "products/product-code-release.ts": {
    writes: 2,
    reason: "moves sku/barcode/unitSku to and from their retired columns only",
  },
  "products/family-price.ts": {
    writes: 2,
    reason: "copies the family's five price columns onto its variants and recipes",
  },
  "products/recipes.service.ts": { writes: 1, reason: "sets kind = RECIPE" },
  "products/product-reactivation-holders.ts": { writes: 1, reason: "sets isActive = false" },
  "products/product-portal-visibility.service.ts": { writes: 1, reason: "sets portalVisible" },
  "products/product-family-cascade.ts": { writes: 1, reason: "sets isActive = false" },
  "products/product-delete-classify.ts": { writes: 1, reason: "sets isActive = false" },
  "returns/returns-restock.util.ts": { writes: 1, reason: "increments currentStock" },
  "returns/returns.service.ts": { writes: 1, reason: "decrements currentStock" },
  "returns/inline-returns.service.ts": { writes: 1, reason: "decrements currentStock" },
  "vendor-bills/vendor-bills.service.ts": {
    writes: 2,
    reason:
      "moves currentStock and averageCost only: the receive, and the one shared reversal revertToDraft and voidBill both go through (SA-808); never category",
  },
  "orders/order-stock.ts": {
    writes: 3,
    reason: "moves currentStock (two product.update calls and one raw UPDATE of currentStock)",
  },
  "import/import.service.ts": {
    writes: 2,
    reason: "Zoho stock sync: updates currentStock, creates a bare product with no category column",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "testing") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

/** Comments out: a `product.update(` in prose is not a write. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const count = (re: RegExp, s: string): number => (s.match(re) ?? []).length;

const found = new Map<string, { writes: number; syncs: number }>();
for (const file of walk(SRC)) {
  const text = code(fs.readFileSync(file, "utf8"));
  const writes = count(WRITE, text);
  if (writes > 0) {
    found.set(path.relative(SRC, file).split(path.sep).join("/"), {
      writes,
      syncs: count(SYNC, text),
    });
  }
}

describe("every Product write is hooked to the label sync or exempt (census)", () => {
  it("scans a real tree (a scan that finds nothing must fail, not pass)", () => {
    expect(found.size).toBeGreaterThan(10);
    expect(found.has("products/products.service.ts")).toBe(true);
  });

  it("has no product-writing file missing from the tables", () => {
    const unlisted = [...found.keys()].filter((f) => !(f in HOOKED) && !(f in EXEMPT));
    expect(
      unlisted.map(
        (f) =>
          `${f}: ${found.get(f)!.writes} product write(s) not listed. If a write can set Product.category (directly, via a spread DTO/row, or by copying a parent's), call syncCategoryLabel(tx, ...) in the SAME transaction and add the file to HOOKED; otherwise add it to EXEMPT with a one-line reason.`,
      ),
    ).toEqual([]);
  });

  it("has no table entry for a file that no longer writes products", () => {
    const stale = [...Object.keys(HOOKED), ...Object.keys(EXEMPT)].filter((f) => !found.has(f));
    expect(stale).toEqual([]);
  });

  it.each(Object.entries(HOOKED))(
    "HOOKED %s: sync call(s) and write count are pinned",
    (file, want) => {
      const got = found.get(file);
      expect({ writes: got?.writes, syncs: got?.syncs }).toEqual({
        writes: want.writes,
        syncs: want.syncs,
      });
    },
  );

  it.each(Object.entries(EXEMPT))(
    "EXEMPT %s: write count is pinned and the file never syncs",
    (file, want) => {
      const got = found.get(file);
      // A moved count means a write was added or removed: re-read the reason (does it still hold?) before updating.
      expect({ writes: got?.writes, syncs: got?.syncs }).toEqual({ writes: want.writes, syncs: 0 });
    },
  );
});
