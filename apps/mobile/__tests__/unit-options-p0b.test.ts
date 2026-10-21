import type { ProductUnitLevel } from "@routeflow/types";
import {
  buildUnitOptions,
  defaultUnitValue,
  unitLineSubtotal,
  unitOptionText,
} from "../lib/unit-options";

// SA-728 / units P0b: the SAME table runs in apps/web/lib/unit-options-p0b.test.ts and
// apps/mobile/__tests__/unit-options-p0b.test.ts. If a twin drifts, its copy of this table goes red.
const level = (
  over: Partial<ProductUnitLevel> & Pick<ProductUnitLevel, "label" | "factorToBase">,
) =>
  ({
    id: over.label,
    price: null,
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
    ...over,
  }) as ProductUnitLevel;

const box24 = { unit: "Box", unitsPerBox: 24, pricePerUnit: "48.00" };
const pack3 = { unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" };
const CASE72 = level({ label: "Case", factorToBase: 72 });

const TABLE: Array<[string, any, ProductUnitLevel[], number, string[]]> = [
  ["no rows: only the pack (master)", box24, [], 1, ["|Box|24|pack|48"]],
  [
    "24 @48, no Piece row: exact derived",
    box24,
    [CASE72],
    1,
    ["|Box|24|pack|48", "Case|Case|72|level|144", "Piece|Piece|1|piece|2"],
  ],
  [
    "3-pack @10, no Piece row: inexact derived",
    pack3,
    [CASE72],
    1,
    ["|Pack|3|pack|10", "Case|Case|72|level|240", "Piece|Piece|1|piece|3.33"],
  ],
  [
    "Piece @2.50 folds into the one base option",
    box24,
    [CASE72, level({ label: "Piece", factorToBase: 1, price: "2.50" })],
    1,
    ["|Box|24|pack|48", "Case|Case|72|level|144", "Piece|Piece|1|piece|2.5"],
  ],
  [
    "tier-3-only Piece row, tier 3 customer",
    box24,
    [CASE72, level({ label: "Piece", factorToBase: 1, priceTier3: "2.10" })],
    3,
    ["|Box|24|pack|48", "Case|Case|72|level|144", "Piece|Piece|1|piece|2.1"],
  ],
];
const TEXTS: Array<[string, any, ProductUnitLevel[], string]> = [
  ["exact derived", box24, [CASE72], "Piece · $2.00"],
  ["inexact derived", pack3, [CASE72], "Piece · ≈$3.33 (1/3 of $10.00)"],
  [
    "own price",
    box24,
    [CASE72, level({ label: "Piece", factorToBase: 1, price: "2.50" })],
    "Piece · $2.50",
  ],
];

describe("SA-728 unit options (web <-> mobile parity table)", () => {
  it.each(TABLE)("%s", (_n, product, units, tier, want) => {
    const got = buildUnitOptions(product, units, tier).map(
      (o) => `${o.value}|${o.label}|${o.factorToBase}|${o.kind}|${o.price}`,
    );
    expect(got).toEqual(want);
  });
  it.each(TEXTS)("option text: %s", (_n, product, units, want) => {
    const piece = buildUnitOptions(product, units, 1).find((o) => o.factorToBase === 1)!;
    expect(unitOptionText(piece)).toBe(want);
  });
  it("3-pack @10: 2 pcs total $6.67 (proration), not 2 x $3.33", () => {
    const piece = buildUnitOptions(pack3, [CASE72], 1).find((o) => o.factorToBase === 1)!;
    expect(unitLineSubtotal(piece, 2)).toBe(6.67);
  });
  it("Box 24 @48 + Piece @2.50: 1 pc is $2.50", () => {
    const units = [CASE72, level({ label: "Piece", factorToBase: 1, price: "2.50" })];
    const piece = buildUnitOptions(box24, units, 1).find((o) => o.factorToBase === 1)!;
    expect(unitLineSubtotal(piece, 1)).toBe(2.5);
  });
  it("a default Piece is visible and is the default value", () => {
    const units = [
      CASE72,
      level({ label: "Piece", factorToBase: 1, price: "2.50", isDefaultSelling: true }),
    ];
    expect(buildUnitOptions(box24, units, 1).some((o) => o.value === "Piece")).toBe(true);
    expect(defaultUnitValue(box24, units, 1)).toBe("Piece");
  });
});
