import { NotFoundException } from "@nestjs/common";
import {
  buildLadderView,
  canonicalUnitRef,
  priceGrid,
  unitCodeOf,
  type ProductCodes,
} from "@routeflow/pricing";
import type { ProductPriceGridDto } from "@routeflow/types";
import { PIECE_NOT_SOLD, ProductPriceGridService } from "./product-price-grid.service";

/**
 * C0 part B: GET products/:productId/price-grid hands the web the pricing package's own grid.
 * The service adds no rounding or rule of its own: the DTO is `priceGrid(buildLadderView(...))`
 * with each row's code from `unitCodeOf`. The five products are PLAN §6's T1/T2 cases.
 */

type UnitRow = {
  id: string;
  label: string;
  factorToBase: number;
  price: string | null;
  priceTier2?: string | null;
  priceTier3?: string | null;
  priceTier4?: string | null;
  priceTier5?: string | null;
  isDefaultSelling?: boolean;
  sku?: string | null;
};

const PRODUCT_ID = "prod-1";

const baseProduct = (over: Record<string, unknown>) => ({
  unit: "Box",
  baseUnitLabel: null,
  packLabel: null,
  unitsPerBox: 12,
  pricePerUnit: "12.00",
  // Product tiers are NOT NULL default 0 in the schema; 0 reads as Auto.
  priceTier2: "0.00",
  priceTier3: "0.00",
  priceTier4: "0.00",
  priceTier5: "0.00",
  sku: "SKU-1",
  barcode: "BC-1",
  unitSku: "PC-1",
  ...over,
});

const unitRow = (over: Partial<UnitRow> & Pick<UnitRow, "id" | "label" | "factorToBase">) => ({
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sku: null,
  ...over,
});

function build(
  product: Record<string, unknown> | null,
  rows: UnitRow[],
  opts: { mode?: "on" | "off"; unitsFlag?: boolean; flagThrows?: boolean } = {},
) {
  const db = {
    product: {
      findFirst: jest.fn().mockResolvedValue(
        product && {
          id: PRODUCT_ID,
          packAuto: 0,
          priceRevision: 0,
          orderUnitRef: "pack",
          ...product,
        },
      ),
    },
    productUnit: { findMany: jest.fn().mockResolvedValue(rows) },
    productTierUnit: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = { forTenant: () => db, getTenantId: () => "t1" };
  const featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue(opts.mode ?? "off") };
  const entitlements = opts.flagThrows
    ? { hasFlag: jest.fn().mockRejectedValue(new Error("down")) }
    : { hasFlag: jest.fn().mockResolvedValue(opts.unitsFlag ?? true) };
  const service = new ProductPriceGridService(
    prisma as never,
    featureConfig as never,
    entitlements as never,
  );
  return { service, db, entitlements };
}

/** What the pricing package alone says the grid is, for the same rows and the same codes. */
function expected(product: ReturnType<typeof baseProduct>, rows: UnitRow[]): ProductPriceGridDto {
  const view = buildLadderView(
    product as never,
    rows.map(({ sku: _sku, ...rest }) => rest) as never,
  );
  const codes: ProductCodes = {
    sku: product.sku,
    barcode: product.barcode,
    unitSku: product.unitSku,
    unitCodes: Object.fromEntries(
      rows.map((r) => [canonicalUnitRef(rows as never, r.id), r.sku ?? null]),
    ),
  };
  // SA-809: "base" is writable exactly when a factor-1 ProductUnit backs the piece level.
  const baseBacked = rows.some((r) => r.factorToBase === 1);
  return {
    productId: PRODUCT_ID,
    anchor: view.anchor,
    rows: priceGrid(view).map((g) => ({
      ...g,
      code: unitCodeOf(codes, g.ref),
      ...(g.ref === "base" && !baseBacked
        ? { editable: true, unbacked: true }
        : { editable: true }),
    })),
    revision: 0,
    priceState: expect.stringMatching(/^[0-9a-f]{64}$/),
    tierAnchors: {},
    tierRules: {},
  };
}

const cell = (dto: ProductPriceGridDto, label: string, tier: number) =>
  dto.rows.find((r) => r.label === label)?.cells.find((c) => c.tier === tier);

describe("ProductPriceGridService (units v2)", () => {
  it("never returns an empty grid: every product has its pack row", async () => {
    const { service } = build(baseProduct({}), []);
    const dto = await service.get(PRODUCT_ID);
    expect(dto.rows.length).toBeGreaterThan(0);
    expect(dto.rows[0].cells).toHaveLength(5);
  });

  it("T1: Box $12 of 12 with Tier 2 $11 -> Piece Auto $1.00 / $0.92", async () => {
    const product = baseProduct({ priceTier2: "11.00" });
    const { service } = build(product, []);
    const dto = await service.get(PRODUCT_ID);
    expect(dto).toEqual(expected(product, []));
    expect(cell(dto, "Box", 1)).toEqual({ tier: 1, source: "set", value: 12 });
    expect(cell(dto, "Box", 2)).toEqual({ tier: 2, source: "set", value: 11 });
    expect(cell(dto, "Piece", 1)).toEqual({ tier: 1, source: "auto", value: 1 });
    expect(cell(dto, "Piece", 2)).toEqual({ tier: 2, source: "auto", value: 0.92 });
  });

  it("T2: Case (72) left Auto -> $72", async () => {
    const product = baseProduct({ priceTier2: "11.00" });
    const rows = [unitRow({ id: "u-case", label: "Case", factorToBase: 72, sku: "CASE-1" })];
    const { service } = build(product, rows);
    const dto = await service.get(PRODUCT_ID);
    expect(dto).toEqual(expected(product, rows));
    expect(cell(dto, "Case", 1)).toEqual({ tier: 1, source: "auto", value: 72 });
  });

  it("T2: Case set $66 -> Tier 2 Auto $60.50", async () => {
    const product = baseProduct({ priceTier2: "11.00" });
    const rows = [
      unitRow({ id: "u-case", label: "Case", factorToBase: 72, price: "66.00", sku: "CASE-1" }),
    ];
    const { service } = build(product, rows);
    const dto = await service.get(PRODUCT_ID);
    expect(dto).toEqual(expected(product, rows));
    expect(cell(dto, "Case", 1)).toEqual({ tier: 1, source: "set", value: 66 });
    expect(cell(dto, "Case", 2)).toEqual({ tier: 2, source: "auto", value: 60.5 });
  });

  it("Piece set $1.20 is a set price on the base row", async () => {
    const product = baseProduct({});
    const rows = [
      unitRow({ id: "u-piece", label: "Piece", factorToBase: 1, price: "1.20", sku: "PIECE-1" }),
    ];
    const { service } = build(product, rows);
    const dto = await service.get(PRODUCT_ID);
    expect(dto).toEqual(expected(product, rows));
    expect(cell(dto, "Piece", 1)).toEqual({ tier: 1, source: "set", value: 1.2 });
  });

  it('SA-809: the factor-1 row\'s code lands under "base" and its cell is editable', async () => {
    const rows = [
      unitRow({ id: "u-piece", label: "Piece", factorToBase: 1, price: "1.20", sku: "PIECE-1" }),
    ];
    const { service } = build(baseProduct({ unitSku: null, barcode: "BC-1" }), rows);
    const dto = await service.get(PRODUCT_ID);
    const piece = dto.rows.find((r) => r.ref === "base")!;
    expect(piece.code).toBe("PIECE-1");
    expect(piece.editable).toBe(true);
    expect(piece.notEditableReason).toBeUndefined();
    expect(piece.unbacked).toBeUndefined();
  });

  describe("SA-1082: the implicit piece level", () => {
    const bareRow = async (opts: Parameters<typeof build>[2] = {}) =>
      (await build(baseProduct({}), [], opts).service.get(PRODUCT_ID)).rows.find(
        (r) => r.ref === "base",
      )!;

    it("VP-1: units flag on: editable with its Auto figures, and says no unit backs it", async () => {
      const row = await bareRow();
      expect(row.editable).toBe(true);
      expect(row.notEditableReason).toBeUndefined();
      expect(row.unbacked).toBe(true);
      expect(row.cells[0].source).toBe("auto");
      expect(row.cells[0].value).toBeGreaterThan(0);
    });

    it("VP-4: units flag off: read-only with the sentence, figures still shown", async () => {
      const row = await bareRow({ unitsFlag: false });
      expect(row.editable).toBe(false);
      expect(row.notEditableReason).toBe(PIECE_NOT_SOLD);
      expect(row.notEditableReason).toBe(
        "Follows the pack price. Selling by the piece isn't on for this business.",
      );
      expect(row.unbacked).toBe(true);
      expect(row.cells[0].value).toBeGreaterThan(0);
    });

    it("a failed flag read fails closed", async () => {
      const row = await bareRow({ flagThrows: true });
      expect(row.editable).toBe(false);
      expect(row.notEditableReason).toBe(PIECE_NOT_SOLD);
    });

    it("no other row depends on the flag", async () => {
      const dto = await build(baseProduct({}), [], { unitsFlag: false }).service.get(PRODUCT_ID);
      expect(dto.rows.find((r) => r.ref === "pack")?.editable).toBe(true);
    });
  });

  it("Box $10 of 12 -> Piece Auto $0.83", async () => {
    const product = baseProduct({ pricePerUnit: "10.00" });
    const { service } = build(product, []);
    const dto = await service.get(PRODUCT_ID);
    expect(dto).toEqual(expected(product, []));
    expect(cell(dto, "Piece", 1)).toEqual({ tier: 1, source: "auto", value: 0.83 });
  });

  it("codes come from unitCodeOf: pack barcode, base unit code, a level's own code", async () => {
    const product = baseProduct({});
    const rows = [unitRow({ id: "u-case", label: "Case", factorToBase: 72, sku: "CASE-1" })];
    const { service } = build(product, rows);
    const dto = await service.get(PRODUCT_ID);
    const code = (label: string) => dto.rows.find((r) => r.label === label)?.code;
    expect(code("Box")).toBe("BC-1");
    expect(code("Piece")).toBe("PC-1");
    expect(code("Case")).toBe("CASE-1");
  });

  it("reads the product, its units and tier units for the one tenant client", async () => {
    const { service, db } = build(baseProduct({}), []);
    await service.get(PRODUCT_ID);
    expect(db.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PRODUCT_ID } }),
    );
    expect(db.productUnit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: PRODUCT_ID } }),
    );
    expect(db.productTierUnit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: PRODUCT_ID } }),
    );
  });

  it("serves the revision and a price-state token that moves when a price column moves", async () => {
    const a = await build(baseProduct({}), []).service.get(PRODUCT_ID);
    const b = await build(baseProduct({ priceTier2: "11.00" }), []).service.get(PRODUCT_ID);
    const c = await build(baseProduct({}), []).service.get(PRODUCT_ID);
    expect(a.revision).toBe(0);
    expect(a.priceState).toBe(c.priceState);
    expect(a.priceState).not.toBe(b.priceState);
  });

  it("the order unit and the pack's Auto flags join the view", async () => {
    const rows = [unitRow({ id: "u-piece", label: "Piece", factorToBase: 1, price: "1.00" })];
    const { service } = build(baseProduct({ orderUnitRef: "u-piece", packAuto: 1 }), rows);
    const dto = await service.get(PRODUCT_ID);
    // SA-809: a stored order unit that names the factor-1 row's id reads as the level's ref.
    expect(dto.anchor).toBe("base");
    expect(cell(dto, "Box", 1)?.source).toBe("auto");
  });

  it("rows the write would refuse say so, by mode and level (SA-1041)", async () => {
    const reasons = async (over: Record<string, unknown>, mode: "on" | "off") => {
      const dto = await build(baseProduct(over), [], { mode }).service.get(PRODUCT_ID);
      return dto.rows.map((r) => [r.label, r.editable, r.notEditableReason]);
    };
    const FAMILY_REASON = "Family prices are edited on the family page.";
    // mode off: a variant and a recipe are their own, the implicit base row included (SA-1082)
    for (const over of [{ parentProductId: "fam-1" }, { kind: "RECIPE" }, {}]) {
      expect(await reasons(over, "off")).toEqual([
        ["Box", true, undefined],
        ["Piece", true, undefined],
      ]);
    }
    // mode on: a variant's base level is the family's, its other levels are its own
    const unitRows = [
      unitRow({ id: "u-piece", label: "Piece", factorToBase: 1, price: "1.00" }),
      unitRow({ id: "u-case", label: "Case", factorToBase: 12, price: "10.00" }),
    ];
    const dto = await build(baseProduct({ parentProductId: "fam-1" }), unitRows, {
      mode: "on",
    }).service.get(PRODUCT_ID);
    const byLabel = Object.fromEntries(dto.rows.map((r) => [r.label, r]));
    expect(byLabel.Piece).toMatchObject({
      editable: false,
      notEditableReason: "Priced by the family.",
    });
    expect(byLabel.Case.editable).toBe(true);
    // the product's own five-column row is the base level too
    expect(byLabel.Box).toMatchObject({
      editable: false,
      notEditableReason: "Priced by the family.",
    });
    // a FAMILY is never editable here, in either mode
    for (const mode of ["on", "off"] as const) {
      expect((await reasons({ kind: "FAMILY" }, mode))[0]).toEqual(["Box", false, FAMILY_REASON]);
    }
  });

  it("a product the tenant does not have is a 404", async () => {
    const { service } = build(null, []);
    await expect(service.get(PRODUCT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
