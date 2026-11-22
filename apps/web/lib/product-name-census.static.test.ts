import * as fs from "fs";
import * as path from "path";

/**
 * SA-1216 census: the staff screens that show a product's name show the full "<Family> - <Variant>"
 * name. Each listed file imports the one rule (`displayProductName`) and prints no bare `{x.name}`
 * of a product in JSX. A bare name that is not a product (a supplier) or that reads an already
 * composed row is counted in `allowedBare`, so one more of them still fails. A new staff surface
 * joins CENSUS in its own PR. The product page and the PO files belong to other PRs of the SA-1216
 * decision and are not listed here yet.
 */
const WEB = path.resolve(__dirname, "..");
const RULE = /from "@\/lib\/product-display"/;

/** `allowedBare`: expression -> how many times it may appear. */
const CENSUS: Record<string, { allowedBare: Record<string, number> }> = {
  "app/(dashboard)/products/page.tsx": { allowedBare: {} },
  // The rows these read are composed once in `stockItems` (its `name` is the full name): the stock
  // table row, the adjust picker row and its selected value, the search suggestion (title + text). `s.name` also appears
  // once for a supplier row. The panels fed by their own read use `fullName(...)`.
  "app/(dashboard)/inventory/page.tsx": {
    allowedBare: { "item.name": 1, "p.name": 1, "s.name": 3, "selectedProduct.name": 1 },
  },
  "app/(dashboard)/inventory/movements/page.tsx": { allowedBare: { "m.supplier.name": 1 } },
  "app/(dashboard)/inventory/stock-counts/[id]/page.tsx": { allowedBare: {} },
};

const BARE_NAME_IN_JSX = /\{\s*([A-Za-z_][\w.?]*\.name)\s*\}/g;

function bareNames(source: string): string[] {
  return [...source.matchAll(BARE_NAME_IN_JSX)].map((m) => m[1].replace(/\?/g, ""));
}

describe("SA-1216 product-name census", () => {
  it.each(Object.keys(CENSUS))("%s imports the one rule", (file) => {
    expect(fs.readFileSync(path.join(WEB, file), "utf8")).toMatch(RULE);
  });

  it.each(Object.keys(CENSUS))("%s prints no bare product .name in JSX", (file) => {
    const seen: Record<string, number> = {};
    for (const n of bareNames(fs.readFileSync(path.join(WEB, file), "utf8"))) {
      seen[n] = (seen[n] ?? 0) + 1;
    }
    expect(seen).toEqual(CENSUS[file].allowedBare);
  });

  it("the detector catches a planted bare name", () => {
    expect(bareNames("<p>{product?.name}</p>")).toEqual(["product.name"]);
  });
});
