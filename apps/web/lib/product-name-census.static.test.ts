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

  /**
   * The names the products page keeps outside its rows (the rule editor's chips, the bulk-delete skip
   * list) must CALL the rule: a block that reads `.name` through a lookup passes the JSX census above.
   */
  const NON_JSX_SITES = ["const fullNameOf ="];

  /** The two sites read a product's name only through `fullNameOf(` (which calls the rule). */
  const NAME_SITES = ["const selectedNames =", "setSkipNames("];

  /** The text of the statement that starts at `anchor` (to the first blank-line-free 600 chars). */
  function siteBlock(source: string, anchor: string): string {
    const at = source.indexOf(anchor);
    return at < 0 ? "" : source.slice(at, at + 600);
  }

  /** True when the block calls the rule and reads no `.name` of its own. */
  function callsRuleOnly(block: string): boolean {
    return /displayProductName\(/.test(block) && !/\)\??\.name\b/.test(block);
  }

  it.each(NON_JSX_SITES)("products page: %s goes through a call of the rule", (anchor) => {
    const source = fs.readFileSync(path.join(WEB, "app/(dashboard)/products/page.tsx"), "utf8");
    const block = siteBlock(source, anchor);
    expect(block).not.toBe("");
    expect(callsRuleOnly(block)).toBe(true);
  });

  it.each(NAME_SITES)(
    "products page: %s takes the name from fullNameOf, not from .name",
    (anchor) => {
      const source = fs.readFileSync(path.join(WEB, "app/(dashboard)/products/page.tsx"), "utf8");
      const block = siteBlock(source, anchor);
      expect(block).toMatch(/fullNameOf\(/);
      expect(block).not.toMatch(/\)\??\.name\b/);
    },
  );

  it("the call check catches a planted bare lookup and a bare name that only imports the rule", () => {
    expect(callsRuleOnly("const name = productById.get(id)?.name;")).toBe(false);
    expect(callsRuleOnly("// displayProductName\nconst name = byId.get(id)?.name;")).toBe(false);
    expect(callsRuleOnly("const name = displayProductName(byId.get(id));")).toBe(true);
  });
});
