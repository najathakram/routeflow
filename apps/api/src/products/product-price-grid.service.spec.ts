import { NotFoundException } from "@nestjs/common";
import { buildLadderView, priceGrid, unitCodeOf, type ProductCodes } from "@routeflow/pricing";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPriceGridService } from "./product-price-grid.service";

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

function build(product: Record<string, unknown> | null, rows: UnitRow[]) {
  const db = {
    product: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
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
  const prisma = { forTenant: () => db };
  const service = new ProductPriceGridService(prisma as never);
  return { service, db };
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
    unitCodes: Object.fromEntries(rows.map((r) => [r.id, r.sku ?? null])),
  };
  return {
    productId: PRODUCT_ID,
    anchor: view.anchor,
    rows: priceGrid(view).map((g) => ({ ...g, code: unitCodeOf(codes, g.ref) })),
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
    expect(dto.anchor).toBe("u-piece");
    expect(cell(dto, "Box", 1)?.source).toBe("auto");
  });

  it("a product the tenant does not have is a 404", async () => {
    const { service } = build(null, []);
    await expect(service.get(PRODUCT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
