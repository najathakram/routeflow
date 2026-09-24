import type { ProductUnitLevel } from "@routeflow/types";
import { cascadePatch, proposeCascade } from "./unit-cascade";

const unit = (
  id: string,
  label: string,
  prices: Array<string | null> = [null, null, null, null, null],
): ProductUnitLevel => ({
  id,
  label,
  factorToBase: 12,
  price: prices[0],
  priceTier2: prices[1],
  priceTier3: prices[2],
  priceTier4: prices[3],
  priceTier5: prices[4],
  isDefaultSelling: false,
  sortOrder: 0,
});

const N = null;

describe("proposeCascade — every tier, each independently", () => {
  const units = [
    unit("case", "Case", ["42.00", "40.00", N, N, N]),
    unit("pallet", "Pallet", ["480.00", "450.00", "420.00", N, N]),
    unit("derived", "Derived"),
  ];

  it("a tier-1 edit offers each OTHER level's explicit tier-1 price the same ratio, rounded once", () => {
    // Case tier 1: 42 -> 40 (x 40/42). Pallet 480 -> 457.14. Edited + derived rows excluded.
    expect(proposeCascade(units, "case", [42, N, N, N, N], [40, N, N, N, N])).toEqual([
      {
        unitId: "pallet",
        label: "Pallet",
        changes: [{ field: "price", tier: 1, from: 480, to: 457.14 }],
      },
    ]);
  });

  it("a tier-2 edit offers tier 2 (and only tier 2) — it never touches anyone's tier 1", () => {
    const out = proposeCascade(units, "case", [42, 40, N, N, N], [42, 36, N, N, N]); // tier 2: 40 -> 36 (x 0.9)
    expect(out).toEqual([
      {
        unitId: "pallet",
        label: "Pallet",
        changes: [{ field: "priceTier2", tier: 2, from: 450, to: 405 }],
      },
    ]);
  });

  it("several tiers edited at once each get their OWN ratio", () => {
    const out = proposeCascade(units, "case", [42, 40, N, N, N], [21, 20, N, N, N]); // both halved
    expect(out[0].changes).toEqual([
      { field: "price", tier: 1, from: 480, to: 240 },
      { field: "priceTier2", tier: 2, from: 450, to: 225 },
    ]);
  });

  it("a level with no explicit price at the edited tier is skipped (it derives and follows automatically)", () => {
    // Pallet has no tier 4; Case has no tier 3. Editing tier 3 of the edited level offers Pallet's tier 3 only.
    const out = proposeCascade(units, "case", [N, N, 40, N, N], [N, N, 36, N, N]);
    expect(out).toEqual([
      {
        unitId: "pallet",
        label: "Pallet",
        changes: [{ field: "priceTier3", tier: 3, from: 420, to: 378 }],
      },
    ]);
    expect(proposeCascade(units, "case", [N, N, N, 10, N], [N, N, N, 9, N])).toEqual([]);
  });

  it.each([
    ["no change", [42, N, N, N, N], [42, N, N, N, N]],
    ["price newly set (no old ratio)", [N, N, N, N, N], [40, N, N, N, N]],
    ["price cleared (back to derived)", [42, N, N, N, N], [N, N, N, N, N]],
    ["zero old price", [0, N, N, N, N], [40, N, N, N, N]],
    ["zero new price", [42, N, N, N, N], [0, N, N, N, N]],
  ])("proposes nothing for %s", (_n, o, n) => {
    expect(proposeCascade(units, "case", o as never, n as never)).toEqual([]);
  });

  it("skips a price that would not move after rounding", () => {
    const tiny = [unit("a", "A", ["0.01", N, N, N, N]), unit("b", "B", ["10.00", N, N, N, N])];
    expect(proposeCascade(tiny, "edited", [42, N, N, N, N], [41, N, N, N, N])).toEqual([
      { unitId: "b", label: "B", changes: [{ field: "price", tier: 1, from: 10, to: 9.76 }] },
    ]);
  });

  it("cascadePatch turns a proposal into one PATCH body over just the changed fields", () => {
    const [p] = proposeCascade(units, "case", [42, 40, N, N, N], [21, 20, N, N, N]);
    expect(cascadePatch(p)).toEqual({ price: 240, priceTier2: 225 });
  });
});
