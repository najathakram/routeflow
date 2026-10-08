import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PriceType } from "@prisma/client";
import type { CategoryTaxSnapshot, LadderUnit } from "@routeflow/pricing";
import { resolveLineUnits } from "../products/line-units";
import {
  MAX_LINE_QTY,
  assertMayUseUnits,
  buildUnitLine,
  categoryTaxForLine,
  isUnitAware,
  requestsUnit,
} from "./unit-line-build";

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
const STUB_SNAPSHOT: CategoryTaxSnapshot = {
  categoryTaxType: "EXCISE_PER_UNIT",
  categoryTaxRate: 1.5,
  categoryPriceIncludesTax: false,
};
const taxFor = jest.fn((qty: number, subtotal: number) => ({
  amount: qty + subtotal / 1000,
  snapshot: STUB_SNAPSHOT,
}));
const build = (item: Record<string, unknown>, tier = 1, label = "Case") =>
  buildUnitLine({
    product,
    units,
    resolved: resolveLineUnits(product, units, { unitLabel: label }),
    item: { productId: "p1", qty: 3, unitLabel: label, ...item },
    tier,
    taxFor,
    position: 4,
    tenantId: "t1",
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
    expect(l.originalPrice).toBe(10080); // the tier-1 unit price, like a SPECIAL pack line
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
        position: 0,
        tenantId: "t1",
      }),
    ).toThrow(/unit-aware/);
  });

  // B682/SA-145: this is the EDIT-path wrong-money shape — Math.trunc used to
  // silently bill 1 Case for a typed 1.5. CREATE's own DTO is already @IsInt,
  // so it never reached here fractional; unit-line-edit.ts's looser DTO
  // (@IsNumber @Min(1)) does. Now refused, with buildLine's error mapped to
  // this endpoint's own wording — the SAME wording invoice-unit-line.ts uses.
  it("B682: a fractional unit count is refused, never truncated (the EDIT-path wrong-money shape)", () => {
    expect(() => build({ qty: 1.5 })).toThrow(
      "A line sold by the Case needs a whole number of Case.",
    );
    expect(() => build({ qty: 2.9 })).toThrow(BadRequestException);
  });

  it("hands the regulated-tax callback the BASE piece count and the line subtotal, and carries the snapshots", () => {
    const l = build({});
    expect(taxFor).toHaveBeenCalledWith(864, 1440);
    expect(l.categoryTaxAmount).toBe(864 + 1.44);
    expect(l.trackedCategoryId).toBe("cat-1");
    expect(l.trackedSubcategoryId).toBe("sub-1");
  });

  it("B297: carries the rate-snapshot trio taxFor returned alongside the amount", () => {
    const l = build({});
    expect(l.categoryTaxType).toBe("EXCISE_PER_UNIT");
    expect(l.categoryTaxRate).toBe(1.5);
    expect(l.categoryPriceIncludesTax).toBe(false);
  });

  it("a typed price is compared to the TIER-1 unit price, exactly like the pack branch", () => {
    // tier 2 Pallet = 9600, tier 1 = 10080: typing 9800 sits BETWEEN them -> below list = DISCOUNTED
    const l = build({ qty: 1, unitPrice: 9800 }, 2, "Pallet");
    expect(l).toMatchObject({
      unitPrice: 9800,
      priceType: PriceType.DISCOUNTED,
      originalPrice: 10080,
    });
  });

  it("carries position and tenantId on the line (a nested create bypasses forTenant())", () => {
    expect(build({})).toMatchObject({ position: 4, tenantId: "t1", name: null });
  });

  it("a bad customer tier is a 400, not a 500", () => {
    expect(() => build({}, 0)).toThrow(BadRequestException);
    expect(() => build({}, 6)).toThrow(/pricing tier/);
  });

  it("a line too big for its Decimal columns is a 400, not an order-wide 500", () => {
    expect(() => build({ qty: Math.floor(MAX_LINE_QTY / 288) + 1 })).toThrow(/over the/);
    expect(() => build({ qty: 100_000 }, 1, "Pallet")).toThrow(BadRequestException); // 5.76e8 pieces
    expect(() => build({ qty: 99_999, unitPrice: 999_999 }, 1, "Piece")).toThrow(/total is over/);
  });

  it("only a unit-aware resolution is built: the pack and a Piece on an unboxed product stay on the pack branch", () => {
    expect(isUnitAware(resolveLineUnits(product, units, { unitLabel: "Case" }))).toBe(true);
    expect(isUnitAware(resolveLineUnits(product, units, { unitLabel: "Box" }))).toBe(false);
    expect(isUnitAware(resolveLineUnits(product, units, { unitLabel: null }))).toBe(false);
    const unboxed = { ...product, unitsPerBox: 1 };
    expect(isUnitAware(resolveLineUnits(unboxed, units, { unitLabel: "Piece" }))).toBe(false);
  });

  it("a factor-1 level under any name is a per-piece line (not units stored as pieces)", () => {
    const each = level({ label: "Each", factorToBase: 1 });
    const l = buildUnitLine({
      product,
      units: [each],
      resolved: resolveLineUnits(product, [each], { unitLabel: "Each" }),
      item: { productId: "p1", qty: 4, unitLabel: "Each" },
      tier: 1,
      taxFor,
      position: 0,
      tenantId: "t1",
    });
    expect(l).toMatchObject({ boxes: null, qty: 4, unitsPerBox: 1, unitLabel: "Each" });
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
    await assertMayUseUnits(
      [{ productId: "p1" }, { unitLabel: "", productId: "p1" }],
      ctx({ isStaff: false, tenantId: null }),
    );
    expect(hasFlag).not.toHaveBeenCalled();
  });

  it("refuses a unit on a custom (unlisted) line instead of silently dropping it", async () => {
    await expect(
      assertMayUseUnits([{ unitLabel: "Case", productId: null }], ctx()),
    ).rejects.toThrow(/custom line/);
    expect(hasFlag).not.toHaveBeenCalled();
    await expect(
      assertMayUseUnits([{ unitLabel: "Case", productId: "p1" }], ctx()),
    ).resolves.toBeUndefined();
  });

  it("refuses a buyer before the entitlement is even read", async () => {
    await expect(
      assertMayUseUnits([{ unitLabel: "Case", productId: "p1" }], ctx({ isStaff: false })),
    ).rejects.toThrow(BadRequestException);
    expect(hasFlag).not.toHaveBeenCalled();
  });

  it("refuses a tenant without flag.units_v1 and a tenant-less caller (fails closed)", async () => {
    hasFlag.mockResolvedValue(false);
    await expect(
      assertMayUseUnits([{ unitLabel: "Case", productId: "p1" }], ctx()),
    ).rejects.toThrow(ForbiddenException);
    expect(hasFlag).toHaveBeenCalledWith("t1", "flag.units_v1");
    hasFlag.mockClear();
    await expect(
      assertMayUseUnits([{ unitLabel: "Case", productId: "p1" }], ctx({ tenantId: null })),
    ).rejects.toThrow(ForbiddenException);
    expect(hasFlag).not.toHaveBeenCalled();
  });

  it("lets a staff caller on a granted tenant through", async () => {
    await expect(
      assertMayUseUnits([{ unitLabel: "Case", productId: "p1" }], ctx()),
    ).resolves.toBeUndefined();
  });
});

describe("categoryTaxForLine — B297 amount + snapshot, one call, never independently computed", () => {
  it("returns an all-null snapshot alongside a zero amount when there is no category", () => {
    expect(categoryTaxForLine(null, 100, 1000)).toEqual({
      amount: 0,
      snapshot: { categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null },
    });
  });

  it("stamps the trio the amount was actually computed from", () => {
    const category = { taxType: "EXCISE_PER_UNIT", rate: "1.25", priceIncludesTax: false };
    const result = categoryTaxForLine(category, 100, 1000);
    expect(result.amount).toBe(125); // 1.25 * 100
    expect(result.snapshot).toEqual({
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 1.25,
      categoryPriceIncludesTax: false,
    });
  });
});

/**
 * #2277 — a line HELD in a unit the product no longer offers (the Case was removed from the product
 * after the order was placed). resolveLineUnits keeps the held unit through its snapshot factor, and
 * the price step then asked the ladder for a "Case" it no longer has: UnknownUnitError escaped as a
 * 500. It is a 400 with a code and a readable remedy instead.
 */
describe("buildUnitLine — a held unit the product no longer offers (#2277)", () => {
  const withoutCase = units.filter((u) => u.label !== "Case");
  const heldCase = () =>
    buildUnitLine({
      product,
      units: withoutCase,
      resolved: resolveLineUnits(
        product,
        withoutCase,
        { unitLabel: "Case" },
        { unitLabel: "Case", unitsPerBox: 288 },
      ),
      item: { productId: "p1", qty: 3, unitLabel: "Case" },
      tier: 1,
      taxFor,
      position: 4,
      tenantId: "t1",
    });

  it("#2277: is a 400 UNIT_NOT_OFFERED naming the unit, never a 500", () => {
    let caught: unknown;
    try {
      heldCase();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const body = (caught as BadRequestException).getResponse() as {
      code?: string;
      message?: string;
    };
    expect(body.code).toBe("UNIT_NOT_OFFERED");
    expect(body.message).toMatch(/Case/);
    expect(body.message).toMatch(/no longer offered/);
  });

  it("#2277: a NEW line asking for a unit the product never had is the same 400 code", () => {
    let caught: unknown;
    try {
      resolveLineUnits(product, units, { unitLabel: "Crate" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(((caught as BadRequestException).getResponse() as { code?: string }).code).toBe(
      "UNIT_NOT_OFFERED",
    );
  });
});

describe("buildUnitLine — snapshot fallback for an EXISTING line (units P0b)", () => {
  // The line was sold as a "Carton" (12 pcs @ $100); the level has since been renamed/removed.
  const liveUnits = [level({ label: "Case", factorToBase: 288, price: "480.00" })];
  const existing = {
    unitLabel: "Carton",
    unitsPerBox: 12,
    unitPrice: 100,
    originalPrice: null,
    priceType: PriceType.STANDARD,
  };
  const rebuild = (withExisting: boolean) =>
    buildUnitLine({
      product,
      units: liveUnits,
      resolved: resolveLineUnits(product, liveUnits, undefined, existing),
      item: { productId: "p1", qty: 3, unitLabel: "Carton" },
      tier: 1,
      taxFor,
      position: 0,
      tenantId: "t1",
      ...(withExisting ? { existing } : {}),
    } as never);

  it("re-resolves from its own snapshot: factor = unitsPerBox, price = unitPrice, no UnknownUnitError", () => {
    const line = rebuild(true);
    expect(line).toMatchObject({
      unitLabel: "Carton",
      unitsPerBox: 12,
      unitPrice: 100,
      qty: 36,
      boxes: 3,
      subtotal: 300,
      priceType: PriceType.STANDARD,
    });
  });
  it("a NEW line (no snapshot) naming an unknown unit is still the 400 UNIT_NOT_OFFERED", () => {
    expect(() => rebuild(false)).toThrow(BadRequestException);
  });
});
