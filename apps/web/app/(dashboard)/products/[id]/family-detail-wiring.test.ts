import * as fs from "fs";
import * as path from "path";

/**
 * WS8: the product detail page swaps the legacy variants card for the family editor when
 * `kind === "FAMILY"` (a family is a non-stocked container: no "Assign to variants" stock split).
 * Source pin — the page is ~2.9k lines and not worth mounting for a two-branch condition.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("products/[id]/page.tsx — family wiring (WS8)", () => {
  it("renders FamilyVariantsEditor for a FAMILY with its id and variants", () => {
    expect(src).toMatch(
      /import \{ FamilyVariantsEditor \} from "@\/components\/family\/FamilyVariantsEditor";/,
    );
    expect(src).toMatch(
      /product\.kind === "FAMILY"[\s\S]{0,400}<FamilyVariantsEditor[\s\S]{0,120}familyId=\{product\.id\}[\s\S]{0,80}variants=\{product\.variants \?\? \[\]\}/,
    );
  });

  it("the legacy variants card is skipped for a family", () => {
    expect(src).toMatch(/\{!product\.parentProductId && product\.kind !== "FAMILY" && \(/);
  });

  it("B2 (#2919): a FAMILY shows no stock or sell UI — no Out-of-Stock badge, no Stock & Cost card, no Make variant", () => {
    // the header badge reads getStockStatus, which answers IN_STOCK (no badge) for a FAMILY
    expect(src).toMatch(
      /function getStockStatus\([^)]*kind\?: string\)[^{]*\{\s*if \(kind === "FAMILY"\) return "IN_STOCK"/,
    );
    expect(src).toMatch(/getStockStatus\(currentStock, product\.isActive, product\.kind\)/);
    // the Stock & Cost card (Set cost, movements) is not rendered for a family
    expect(src).toMatch(/product\.kind !== "FAMILY" && \(\s*<ProductStockCostCard/);
    // "Make variant of…" is not offered on a family
    // (the header buttons live in ProductHeaderControls since VU-2)
    const header = fs.readFileSync(path.join(__dirname, "ProductHeaderControls.tsx"), "utf8");
    expect(header).toMatch(/isOperator && !product\.parentProductId && product\.kind !== "FAMILY"/);
    expect(src).toMatch(/<ProductHeaderControls/);
  });

  it("the page stays under its size-ratchet cap (the Stock & Cost card lives in its own component)", () => {
    expect(src.split("\n").length).toBeLessThanOrEqual(2967);
  });
});
