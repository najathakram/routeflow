import * as fs from "fs";
import * as path from "path";

/**
 * Units v2 parity: with the flag on, a FAMILY product page loses ONLY "Family page tiers",
 * "units card" and "Create an order". Every other family-page control keeps its home.
 * Source pin: the page is too large to mount for a render-gate check.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

// Controls that must render on a family page with the flag on, each unconditioned on v2/v2Family.
const KEPT: Array<[string, RegExp]> = [
  ["labels card", /^\s*<ProductLabelsCard productId=\{product\.id\} \/>/m],
  ["portal visibility card", /^\s*<ProductPortalVisibilityCard product=\{product\} \/>/m],
  ["demand card", /^\s*<DemandCard productId=\{product\.id\}/m],
  ["sales history card", /^\s*<SalesHistoryCard productId=\{product\.id\}/m],
  ["insights export", /^\s*<ProductInsightsExport productId=\{product\.id\}/m],
  ["cost history card", /^\s*<CostHistoryCard productId=\{product\.id\} \/>/m],
  ["header controls", /^\s*<ProductHeaderControls/m],
  ["header line", /^\s*<ProductHeaderLine product=\{product\}/m],
];

describe("family page with units v2 on: parity", () => {
  it.each(KEPT)("keeps the %s ungated by v2", (_name, re) => {
    expect(src).toMatch(re);
  });

  it("the family variants editor is gated only on kind === FAMILY", () => {
    expect(src).toMatch(
      /^\s*\{product\.kind === "FAMILY" && \(\s*<FamilyVariantsEditor familyId=\{product\.id\}/m,
    );
  });

  it("v2Family removes exactly the units card (K11-25: the create-an-order link is hidden on EVERY family, in FamilySalesCards)", () => {
    const uses = src
      .split("\n")
      .filter((l) => l.includes("v2Family") && !l.includes("const v2Family"));
    expect(uses).toHaveLength(1);
    expect(uses.some((l) => /!v2Family && <ProductUnitsCard/.test(l))).toBe(true);
    const cards = fs.readFileSync(path.join(__dirname, "FamilySalesCards.tsx"), "utf8");
    expect(cards).toMatch(
      /<SalesHistoryCard productId=\{productId\} hideCreateOrder compactEmpty \/>/,
    );
    expect(src).toMatch(/<FamilySalesCards productId=\{product\.id\}/);
  });

  it("K11-25: a family's Demand card shows only when there is sales history (one empty state, not two)", () => {
    const cards = fs.readFileSync(path.join(__dirname, "FamilySalesCards.tsx"), "utf8");
    expect(cards).toMatch(/hasHistory && <DemandCard/);
    expect(cards).toMatch(/useProductSales\(productId\)/);
  });

  it("the v2 family tiers grid is the only other family removal", () => {
    // K11-20c: the section sits in ProductPricingRegion (the inline edit mode's full-width wrapper)
    expect(src).toMatch(
      /v2 && product\.kind !== "FAMILY" \? \(\s*<ProductPricingRegion>\s*<ProductPricingV2 product=\{product\} \/>/,
    );
  });

  it("pins every bare v2 reference in page.tsx to the known set", () => {
    const refs = src
      .split("\n")
      .filter((l) => /(?<![-\w/"])v2(?![\w-])/.test(l))
      .filter((l) => !/const v2( |Family)/.test(l))
      .map((l) => l.trim());
    expect(refs).toEqual([
      // The Units & prices card reads only where the grid shell mounts the controls that replace it (D-2026-10-18)
      "const cardRo = v2 && unitStructure;",
      // K11-20c: prices are edited in the floating window (and shown read-only in Details) for a non-governed product
      "const pricesInWindow = v2 && !unitStructureGoverned(product);",
      '{v2 ? null : stockStatus === "OUT_OF_STOCK" ? (',
      "<ProductHeaderLine product={product} currentStock={currentStock} pricesV2={v2} />",
      '{v2 && product.kind !== "FAMILY" ? <ProductJumpLinks reserveSpace /> : null}',
      "pricesV2={v2}",
      '{v2 && product.kind !== "FAMILY" ? (',
      // K10d: the v2 flag drops the old Units card's always-open Add form (the shell's Add a unit replaces it)
      "{!v2Family && <ProductUnitsCard product={product} hideAddForm={v2} readOnly={cardRo} />}",
    ]);
  });
});
