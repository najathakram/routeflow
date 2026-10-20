import * as fs from "fs";
import * as path from "path";

/**
 * R3 review (phone spacing): the first money figure must start on the first 844 px screen at 390, so every gap between
 * the Details card and the first price row tightens BELOW sm only. jsdom has no layout, so these pin the classes; the
 * k11-l3-23 e2e is the measurement. Each pin is max-sm:, so 768 and 1440 keep their spacing exactly.
 */
const D = path.join(__dirname, "..", "..");
const src = (...p: string[]) => fs.readFileSync(path.join(D, ...p), "utf8");

describe("phone spacing above the first price row (below sm only)", () => {
  it("the opener row, the structure block and the actions row tighten", () => {
    const u = src("units-v2", "structure", "UnitStructure.tsx");
    expect(u).toMatch(/"mt-3 max-sm:mt-0 flex flex-wrap/);
    expect(u).toMatch(/data-testid="units-v2-structure" className="mb-3 max-sm:mb-2"/);
  });

  it("the grid card drops its top padding only when the heading has moved out, and each phone card tightens", () => {
    const g = src("ProductPricesGrid.tsx");
    expect(g).toMatch(/hideTitle \? "max-sm:pt-2" : ""/);
    expect(g).toMatch(/rounded-md border p-3 max-sm:pt-2/);
    expect(g).toMatch(/mb-2 max-sm:mb-1 text-xs/);
  });

  it("the Details card's bottom padding and the More details trigger tighten (read mode)", () => {
    expect(src("page.tsx")).toMatch(/isEditing && "pb-24 md:pb-6", !isEditing && "max-sm:pb-3"/);
    expect(src("DetailsMore.tsx")).toMatch(/mt-5 max-sm:mt-3 flex min-h-\[44px\]/);
  });
});
