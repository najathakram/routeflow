import { Injectable, NotFoundException } from "@nestjs/common";
import {
  DEFAULT_TIER_RULES,
  buildLadderView,
  priceGrid,
  unitCodeOf,
  type LadderView,
  type ProductCodes,
  type TierRules,
} from "@routeflow/pricing";
import type { ProductPriceGridDto } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { computePriceState } from "./price-state";

/** Only what the ladder and the unit codes read; no cost, stock or tenant columns. */
export const PRODUCT_SELECT = {
  id: true,
  unit: true,
  baseUnitLabel: true,
  packLabel: true,
  unitsPerBox: true,
  pricePerUnit: true,
  priceTier2: true,
  priceTier3: true,
  priceTier4: true,
  priceTier5: true,
  packAuto: true,
  priceRevision: true,
  orderUnitRef: true,
  parentProductId: true,
  kind: true,
  sku: true,
  barcode: true,
  unitSku: true,
} as const;

/** The refusal for the implicit base row: the unit must exist before it can carry a price (K7 adds it). */
export const addUnitFirst = (label: string): string => `Add the ${label} unit first.`;

/**
 * Why the price write refuses this product, or null when it is a standalone product. One source for the grid's
 * `notEditableReason` and the write's refusal, so the UI never offers an edit the server would turn down.
 */
export function governedReason(p: {
  parentProductId?: string | null;
  kind?: string | null;
}): string | null {
  if (p.parentProductId) return "Priced by the family.";
  if (p.kind === "FAMILY") return "Family prices are edited on the family page.";
  if (p.kind === "RECIPE") return "Priced by its recipe.";
  return null;
}

/** The unit columns the ladder, the codes and the price state read. */
export const UNIT_PRICE_SELECT = {
  id: true,
  label: true,
  factorToBase: true,
  price: true,
  priceTier2: true,
  priceTier3: true,
  priceTier4: true,
  priceTier5: true,
  isDefaultSelling: true,
  sortOrder: true,
  parentUnitId: true,
  perParent: true,
  sku: true,
} as const;

type Db = any;

/** Everything one price read knows; the write path reads the same model under its lock. */
export interface PriceModel {
  product: any;
  units: any[];
  view: LadderView;
  rules: TierRules;
  revision: number;
  priceState: string;
  grid: ProductPriceGridDto;
}

/**
 * The read model behind GET products/:productId/price-grid (units v2, flag.units_prices_v2), and the one the price
 * write re-reads inside its transaction.
 *
 * It adds no rule of its own: the grid is `priceGrid(buildLadderView(...))` from @routeflow/pricing at the
 * tenant's tier rules (0% until the rules setting is read here), and every row's code is `unitCodeOf`. The product
 * and its units are read for the caller's tenant only (a product outside it is a 404). The order unit, the tier order
 * units and the pack's Auto flags join the view.
 */
@Injectable()
export class ProductPriceGridService {
  constructor(private readonly prisma: PrismaService) {}

  get(productId: string): Promise<ProductPriceGridDto> {
    return this.read(this.prisma.forTenant(), productId).then((m) => m.grid);
  }

  /** `db` = the tenant client or a tenant transaction client. */
  async read(db: Db, productId: string): Promise<PriceModel> {
    const product = await db.product.findFirst({
      where: { id: productId },
      select: PRODUCT_SELECT,
    });
    if (!product) throw new NotFoundException("Product not found");

    const units: any[] = await db.productUnit.findMany({
      where: { productId },
      select: UNIT_PRICE_SELECT,
      orderBy: [{ sortOrder: "asc" }, { factorToBase: "asc" }],
    });
    const tierUnits: { tier: number; orderUnitRef: string | null }[] =
      await db.productTierUnit.findMany({
        where: { productId },
        select: { tier: true, orderUnitRef: true },
      });
    const rules = DEFAULT_TIER_RULES;

    const tierOrderUnits: Partial<Record<2 | 3 | 4 | 5, string | null>> = {};
    for (const t of tierUnits) {
      if (t.tier >= 2 && t.tier <= 5) tierOrderUnits[t.tier as 2 | 3 | 4 | 5] = t.orderUnitRef;
    }
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
      { orderUnit: product.orderUnitRef, tierOrderUnits, packAuto: product.packAuto },
    );
    const codes: ProductCodes = {
      sku: product.sku,
      barcode: product.barcode,
      unitSku: product.unitSku,
      unitCodes: Object.fromEntries(units.map((u) => [u.id, u.sku ?? null])),
    };
    const revision = Number(product.priceRevision) || 0;
    const priceState = computePriceState(product, units, tierUnits);
    const grid: ProductPriceGridDto = {
      productId,
      anchor: view.anchor,
      rows: priceGrid(view, rules).map((row) => {
        // The implicit piece row (no ProductUnit yet) cannot be priced: the write never mints a unit.
        const reason =
          governedReason(product) ?? (row.ref === "base" ? addUnitFirst(row.label) : null);
        return {
          ...row,
          code: unitCodeOf(codes, row.ref),
          editable: reason == null,
          ...(reason ? { notEditableReason: reason } : {}),
        };
      }),
      revision,
      priceState,
      tierAnchors: { ...view.tierAnchors },
      tierRules: { ...rules },
    };
    return { product, units, view, rules, revision, priceState, grid };
  }
}
