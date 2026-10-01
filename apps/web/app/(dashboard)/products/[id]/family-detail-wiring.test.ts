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
});
