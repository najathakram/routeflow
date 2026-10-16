import * as fs from "fs";
import * as path from "path";

/**
 * T38 (units v2, S11): a feature-parity inventory of today's product page. Every control the
 * page offers has a named home; adding the v2 grid must not take one away. Source pins, because
 * page.tsx is ~2.4k lines and not worth mounting.
 */
const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const page = read("page.tsx");

/** Cards/controls mounted by the page today, each with the file that owns its controls. */
const MOUNTED: Array<[tag: string, file: string]> = [
  ["ProductHeaderLine", "ProductHeaderLine.tsx"],
  ["ProductHeaderControls", "ProductHeaderControls.tsx"],
  ["ProductStockCostCard", "ProductStockCostCard.tsx"],
  ["ProductLabelsCard", "ProductLabelsCard.tsx"],
  ["ProductPortalVisibilityCard", "ProductPortalVisibilityCard.tsx"],
  ["ProductUnitsCard", "ProductUnitsCard.tsx"],
  ["DemandCard", "DemandCard.tsx"],
  ["SalesHistoryCard", "SalesHistoryCard.tsx"],
  ["ProductInsightsExport", "ProductInsightsExport.tsx"],
  ["LegacyVariantsActions", "LegacyVariantsActions.tsx"],
  ["PiecesPerBoxValue", "PiecesPerBoxValue.tsx"],
];

describe("product page parity inventory (T38)", () => {
  it.each(MOUNTED)("%s is still mounted by the page and its file exists", (tag, file) => {
    expect(page).toMatch(new RegExp(`<${tag}[\\s>]`));
    expect(fs.existsSync(path.join(__dirname, file))).toBe(true);
  });

  it("the old Units card stays mounted whenever the page is not a v2 family", () => {
    expect(page).toMatch(/const v2Family = v2 && product\.kind === "FAMILY";/);
    expect(page).toMatch(/\{!v2Family && <ProductUnitsCard product=\{product\} \/>\}/);
  });

  it("with the flag on and a non-FAMILY product, the v2 grid AND the old units card both render", () => {
    expect(page).toMatch(
      /\{v2 && product\.kind !== "FAMILY" \? <ProductPricingV2 product=\{product\} \/> : null\}/,
    );
    // the old card's gate never mentions v2 except to hide it for a v2 FAMILY
    const oldGate = page.match(/\{([^{}]*)<ProductUnitsCard/);
    expect(oldGate?.[1]).toBe("!v2Family && ");
  });

  it("the v2 shell is mounted exactly once, only behind the flag", () => {
    expect(page.match(/<ProductPricingV2/g)?.length).toBe(1);
    const before = page.slice(0, page.indexOf("<ProductPricingV2")).split("\n").slice(-1)[0];
    expect(before).toMatch(/\{v2 && /);
  });

  it("the old Units card keeps its edit controls (name, price, tiers, default, save, remove)", () => {
    const card = read("ProductUnitsCard.tsx");
    for (const needle of ["} name`", "} price`", "onMakeDefault", "Save", "Remove", "Cancel"]) {
      expect(card).toContain(needle);
    }
  });
});
