import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMON_UNITS } from "./common-units";

/**
 * W2a: ONE list of common unit suggestions. UnitCombobox and the product edit page each declared their
 * own (23 vs 19 entries, the page's a strict subset); both now import this one.
 */
describe("COMMON_UNITS", () => {
  it("is the 23-unit superset, unique and non-empty", () => {
    expect(COMMON_UNITS).toHaveLength(23);
    expect(new Set(COMMON_UNITS).size).toBe(23);
    expect(COMMON_UNITS.every((u) => u.trim().length > 0)).toBe(true);
    // the four the product page used to miss
    for (const u of ["pcs", "bundle", "liter", "strip"]) expect(COMMON_UNITS).toContain(u);
    // everything the product page used to offer
    for (const u of [
      "unit",
      "each",
      "case",
      "box",
      "bag",
      "pack",
      "dozen",
      "pallet",
      "kg",
      "g",
      "lb",
      "oz",
      "L",
      "ml",
      "tray",
      "bottle",
      "can",
      "roll",
      "sheet",
    ])
      expect(COMMON_UNITS).toContain(u);
  });

  it("neither consumer declares its own copy (one list, one place)", () => {
    const root = join(__dirname, "..");
    const files = ["components/UnitCombobox.tsx", "app/(dashboard)/products/[id]/page.tsx"];
    for (const f of files) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src).not.toMatch(/const COMMON_UNITS\s*=\s*\[/);
      expect(src).toMatch(/import \{ COMMON_UNITS \} from "@\/lib\/common-units"/);
    }
  });
});
