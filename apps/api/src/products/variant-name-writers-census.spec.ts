import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { callBlocks, productDataLiterals, WRITE_METHODS } from "./tripwire-scan";

/**
 * B1 (SA ruling) STRUCTURAL census: a variant stores its BARE label, and `product-variant-name.ts` is the ONE normaliser.
 * Every non-spec source file that WRITES a variant's name / variantName must call it (the call counts are pinned), route
 * through a service that does, or sit on the reasoned ALLOWED list. A new writer on none of the lists is red, so it cannot
 * quietly re-open the "Acme - Acme - Classic" corruption.
 *
 * A "writer file" is any non-spec file under src/ that has: (1) a `product|products` write call (create / update / upsert /
 * createMany / updateMany) whose block names `variantName` or `parentProductId`; (2) a `data.variantName =` assignment; or (3) a
 * `variantName:` object key that is not a type annotation or a `true` select flag.
 */
const SRC = join(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (
      /\.ts$/.test(n) &&
      !/\.(spec|test|fake-tx)\.ts$|\.d\.ts$/.test(n) &&
      !/fixtures/.test(n)
    )
      out.push(f);
  }
  return out;
}

const NORMALISER_CALL = /\b(?:stripParentPrefix|bareVariantNames|bareRowNames)\s*\(/g;

/** Files that call the normaliser directly: the EXACT call count is pinned. */
const GUARDED: Record<string, { calls: number; why: string }> = {
  "products/products.service.ts": {
    calls: 2,
    why: "create() and update() strip dto.name / dto.variantName before the name guard and the uniqueness check; bulkAssignParent, make-variant, link-existing, the web save, the mobile edit and the import create/update all reach one of the two",
  },
  "products/product-families.service.ts": {
    calls: 3,
    why: "createFamily (the grid's variants), updateVariants add rows and update (rename) rows; variantData / variantPatch only ever see the stripped rows",
  },
  "inventory/inventory.service.ts": {
    calls: 2,
    why: "the stock split's new variant: the collision check and the created row (name and variantName) both use the bare label",
  },
};

/** Files that write ONLY through ProductsService.create / update (which are GUARDED above). */
const ROUTED: Record<string, string> = {
  "import/variant-resolution.service.ts":
    "createVariant hands the variant to ProductsService.create (the import and scan 'new variant' choice); it writes no variant label of its own",
};

/** Files that match the scan but never write a variant label, each with the reason. */
const ALLOWED: Record<string, string> = {
  "buyer/buyer-catalog-where.ts": "a search filter on variantName (read)",
  "common/safe-text-cell.ts": "the field-label map for the formula-lead refusal copy",
  "common/text-cell-guards.ts": "the formula-lead guard: reads the candidate name, writes nothing",
  "customers/customer-order-suggestions.service.ts":
    "response mapper: copies variantName out (read)",
  "documents/receipt-model.ts": "response mapper: copies variantName out (read)",
  "documents/receipt.service.ts": "a select of variantName (read)",
  "orders/orders.service.ts": "a select of variantName (read)",
  "product-labels/product-labels.service.ts": "a select of variantName (read)",
  "products/dto/bulk-assign-parent.dto.ts": "the request DTO (validated, then handed to update())",
  "products/family-price.ts":
    "propagates PRICE columns to a family's variants (where: parentProductId); writes no name",
};

describe("B1 variant-name writer census", () => {
  const files = walk(SRC).map((f) => ({
    rel: relative(SRC, f).split("\\").join("/"),
    text: strip(readFileSync(f, "utf8")),
  }));

  const isWriterFile = (text: string): boolean => {
    for (const receiver of ["product", "products"]) {
      for (const b of callBlocks(text, receiver, WRITE_METHODS)) {
        if (/variantName|parentProductId/.test(b)) return true;
      }
    }
    return (
      /\bdata\.variantName\s*=(?!=)/.test(text) ||
      /\bvariantName\s*:\s*(?!true\b|string\b|boolean\b|null\b)/.test(text)
    );
  };

  const writerFiles = files.filter((f) => isWriterFile(f.text));
  const known = new Set([...Object.keys(GUARDED), ...Object.keys(ROUTED), ...Object.keys(ALLOWED)]);

  it("every variant-name writer file is on a list: a new one must call the normaliser or be reasoned", () => {
    const unlisted = writerFiles.map((f) => f.rel).filter((r) => !known.has(r));
    expect(unlisted).toEqual([]);
  });

  it("no list row is stale: each listed file still matches the scan", () => {
    const matched = new Set(writerFiles.map((f) => f.rel));
    expect([...known].filter((r) => !matched.has(r))).toEqual([]);
  });

  it.each(Object.entries(GUARDED))(
    "%s calls the ONE normaliser the pinned number of times",
    (rel, row) => {
      const text = files.find((f) => f.rel === rel)!.text;
      expect(text.match(NORMALISER_CALL)?.length ?? 0).toBe(row.calls);
      expect(text).toMatch(/from "(?:\.\.\/products\/|\.\/)product-variant-name"/);
    },
  );

  it.each(Object.entries(ROUTED))("%s writes only through ProductsService", (rel) => {
    const text = files.find((f) => f.rel === rel)!.text;
    expect(text).toMatch(/this\.products\.create\(/);
    // no raw product write of its own that names a variant label
    for (const receiver of ["product"]) {
      for (const b of callBlocks(text, receiver, WRITE_METHODS)) {
        expect(b).not.toMatch(/variantName|parentProductId/);
      }
    }
    expect(productDataLiterals(text).filter((d) => /\b(?:name|variantName)\s*:/.test(d))).toEqual(
      [],
    );
  });

  it.each(Object.keys(ALLOWED))("%s writes no name / variantName of its own", (rel) => {
    const text = files.find((f) => f.rel === rel)!.text;
    expect(productDataLiterals(text).filter((d) => /\b(?:name|variantName)\s*:/.test(d))).toEqual(
      [],
    );
    expect(text).not.toMatch(/\bdata\.(?:variantName|name)\s*=(?!=)/);
  });
});
