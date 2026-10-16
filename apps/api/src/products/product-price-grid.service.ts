import { Injectable, NotFoundException } from "@nestjs/common";
import { buildLadderView, priceGrid, unitCodeOf, type ProductCodes } from "@routeflow/pricing";
import type { ProductPriceGridDto } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { ProductUnitsService } from "./product-units.service";

/** Only what the ladder and the unit codes read; no cost, stock or tenant columns. */
const PRODUCT_SELECT = {
  unit: true,
  baseUnitLabel: true,
  packLabel: true,
  unitsPerBox: true,
  pricePerUnit: true,
  priceTier2: true,
  priceTier3: true,
  priceTier4: true,
  priceTier5: true,
  sku: true,
  barcode: true,
  unitSku: true,
} as const;

/**
 * The read model behind GET products/:productId/price-grid (units v2, flag.units_prices_v2).
 *
 * It adds no rule of its own: the grid is `priceGrid(buildLadderView(...))` from
 * @routeflow/pricing at the 0% tier rules, and every row's code is `unitCodeOf`. The product and
 * its units are read for the caller's tenant only (a product outside it is a 404, from here and
 * from ProductUnitsService.list). Order unit and the pack's Auto flags join the view in S9.
 */
@Injectable()
export class ProductPriceGridService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly units: ProductUnitsService,
  ) {}

  async get(productId: string): Promise<ProductPriceGridDto> {
    const db = this.prisma.forTenant();
    const product = await db.product.findFirst({
      where: { id: productId },
      select: PRODUCT_SELECT,
    });
    if (!product) throw new NotFoundException("Product not found");

    const units = await this.units.list(productId);
    // The unit list does not carry each level's own code.
    const skuRows = await db.productUnit.findMany({
      where: { productId },
      select: { id: true, sku: true },
    });

    // Decimal columns go in as exact strings: the ladder reads them with Number() like every consumer.
    const view = buildLadderView(
      {
        ...product,
        pricePerUnit: product.pricePerUnit.toString(),
        priceTier2: product.priceTier2.toString(),
        priceTier3: product.priceTier3.toString(),
        priceTier4: product.priceTier4.toString(),
        priceTier5: product.priceTier5.toString(),
      },
      units,
    );
    const codes: ProductCodes = {
      sku: product.sku,
      barcode: product.barcode,
      unitSku: product.unitSku,
      unitCodes: Object.fromEntries(skuRows.map((u) => [u.id, u.sku])),
    };
    return {
      productId,
      anchor: view.anchor,
      rows: priceGrid(view).map((row) => ({ ...row, code: unitCodeOf(codes, row.ref) })),
    };
  }
}
