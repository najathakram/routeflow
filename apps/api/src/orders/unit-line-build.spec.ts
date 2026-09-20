import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PriceType } from "@prisma/client";
import type { LadderUnit } from "@routeflow/pricing";
import { resolveLineUnits } from "../products/line-units";
import { assertMayUseUnits, buildUnitLine, requestsUnit } from "./unit-line-build";

// A 24-piece box priced $42.00 (tier 2 $40.00); a Case of 288 pieces with an explicit $480.00 (no
// tier prices → tiers derive); a Pallet with NO price (derived: 42 x 5760 / 24).
const product = {
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: "42.00",
  priceTier2: "40.00",
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: "sub-1",
};
const level = (
  over: Partial<LadderUnit> & { label: string; factorToBase: number },
): LadderUnit => ({
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  ...over,
});
const units = [
  level({ label: "Case", factorToBase: 288, price: "480.00" }),
  level({ label: "Pallet", factorToBase: 5760 }),
];
const taxFor = jest.fn((qty: number, subtotal: number) => qty + subtotal / 1000);
const build = (item: Record<string, unknown>, tier = 1, label = "Case") =>
  buildUnitLine({
    product,
    units,
    resolved: resolveLineUnits(product, units, { unitLabel: label }),
    item: { productId: "p1", qty: 3, unitLabel: label, ...item },
    tier,
    taxFor,
  });

describe("buildUnitLine — an order line sold by a non-pack unit", () => {
  beforeEach(() => taxFor.mockClear());

  it("stores a Case line like a box-split line whose box is the Case (qty in base pieces)", () => {
    const l = build({});
    expect(l).toMatchObject({
      unitLabel: "Case",
      boxes: 3,
      pieces: 0,
      qty: 864,
      unitsPerBox: 288,
      unitPrice: 480,
      subtotal: 1440,
      priceType: PriceType.STANDARD,
      originalPrice: null,
      promoFreeUnits: null,
    });
  });

  it("a level with no explicit price derives from the pack (42 x 5760 / 24 = 10080 per Pallet)", () => {
    const l = build({ qty: 2 }, 1, "Pallet");
    expect(l).toMatchObject({ unitPrice: 10080, subtotal: 20160, qty: 11520, unitsPerBox: 5760 });
  });

  it("uses the customer's tier: tier 2 derives from the tier-2 pack price and is SPECIAL", () => {
    const l = build({ qty: 1 }, 2, "Pallet");
    expect(l.unitPrice).toBe(9600); // 40 x 5760 / 24
    expect(l.priceType).toBe(PriceType.SPECIAL);
  });

  it("a Piece off a boxed pack is a per-piece line that still snapshots factor 1", () => {
    const l = build({ qty: 5 }, 1, "Piece");
    expect(l).toMatchObject({
      unitLabel: "Piece",
      boxes: null,
      pieces: null,
      qty: 5,
      unitsPerBox: 1,
      unitPrice: 1.75, // 42 / 24
      subtotal: 8.75,
    });
  });

  it("a typed price below the ladder is DISCOUNTED, above is a MANUAL upsell — both keep the ladder price as original", () => {
    const down = build({ unitPrice: 450 });
    expect(down).toMatchObject({
      unitPrice: 450,
      priceType: PriceType.DISCOUNTED,
      originalPrice: 480,
      subtotal: 1350,
    });
    const up = build({ unitPrice: 500.005 });
    expect(up).toMatchObject({
      unitPrice: 500.01,
      priceType: PriceType.MANUAL,
      originalPrice: 480,
    });
    expect(build({ unitPrice: 480 }).priceType).toBe(PriceType.STANDARD); // == ladder: no override
  });

  it("refuses boxes/pieces beside a unit (two conflicting axes) but tolerates the web's zero payload", () => {
    expect(() => build({ boxes: 1 })).toThrow(BadRequestException);
    expect(() => build({ pieces: 2 })).toThrow(BadRequestException);
    expect(build({ boxes: 0, pieces: 0 }).qty).toBe(864);
  });

  it("refuses a zero quantity and never accepts the pack (the caller only builds unit-aware lines)", () => {
    expect(() => build({ qty: 0 })).toThrow(BadRequestException);
    expect(() =>
      buildUnitLine({
        product,
        units,
        resolved: resolveLineUnits(product, units, { unitLabel: null }),
        item: { productId: "p1", qty: 1 },
        tier: 1,
        taxFor,
      }),
    ).toThrow(/unit-aware/);
  });

  it("hands the regulated-tax callback the BASE piece count and the line subtotal, and carries the snapshots", () => {
    const l = build({});
    expect(taxFor).toHaveBeenCalledWith(864, 1440);
    expect(l.categoryTaxAmount).toBe(864 + 1.44);
    expect(l.trackedCategoryId).toBe("cat-1");
    expect(l.trackedSubcategoryId).toBe("sub-1");
  });

  it("carries the item note (itemNote wins over notes)", () => {
    expect(build({ notes: "a", itemNote: "b" }).notes).toBe("b");
    expect(build({ notes: "a" }).notes).toBe("a");
  });
});

describe("requestsUnit / assertMayUseUnits — who may sell by a unit, and only under flag.units_v1", () => {
  const hasFlag = jest.fn();
  const ctx = (over: Record<string, unknown> = {}) => ({
    isStaff: true,
    tenantId: "t1",
    hasFlag,
    ...over,
  });
  beforeEach(() => {
    hasFlag.mockReset();
    hasFlag.mockResolvedValue(true);
  });

  it("only a non-blank unitLabel asks for a unit", () => {
    expect(requestsUnit({ unitLabel: "Case" })).toBe(true);
    for (const v of [undefined, null, "", "   "])
      expect(requestsUnit({ unitLabel: v })).toBe(false);
    expect(requestsUnit(undefined)).toBe(false);
  });

  it("consults nothing when no line asks for a unit (a pack-only request is byte-identical)", async () => {
    await assertMayUseUnits([{}, { unitLabel: "" }], ctx({ isStaff: false, tenantId: null }));
    expect(hasFlag).not.toHaveBeenCalled();
  });

  it("refuses a buyer before the entitlement is even read", async () => {
    await expect(
      assertMayUseUnits([{ unitLabel: "Case" }], ctx({ isStaff: false })),
    ).rejects.toThrow(BadRequestException);
    expect(hasFlag).not.toHaveBeenCalled();
  });

  it("refuses a tenant without flag.units_v1 and a tenant-less caller (fails closed)", async () => {
    hasFlag.mockResolvedValue(false);
    await expect(assertMayUseUnits([{ unitLabel: "Case" }], ctx())).rejects.toThrow(
      ForbiddenException,
    );
    expect(hasFlag).toHaveBeenCalledWith("t1", "flag.units_v1");
    hasFlag.mockClear();
    await expect(
      assertMayUseUnits([{ unitLabel: "Case" }], ctx({ tenantId: null })),
    ).rejects.toThrow(ForbiddenException);
    expect(hasFlag).not.toHaveBeenCalled();
  });

  it("lets a staff caller on a granted tenant through", async () => {
    await expect(assertMayUseUnits([{ unitLabel: "Case" }], ctx())).resolves.toBeUndefined();
  });
});
