import { Injectable, NotFoundException } from "@nestjs/common";
import {
  DEFAULT_TIER_RULES,
  buildLadderView,
  canonicalUnitRef,
  priceGrid,
  unitCodeOf,
  type LadderView,
  type LadderViewUnit,
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
 * SA-809: the ProductUnit that backs the piece level ("base"), or null when none does (the implicit Piece row, or a
 * one-piece pack). Keyed on the unit being the level's own row, never on the literal ref: a "base" cell is writable
 * exactly when this finds a row, and it is the row a "base" write lands on.
 */
export function baseBackingUnit<U extends LadderViewUnit>(
  units: readonly U[],
  view: LadderView,
): U | null {
  const baseRow = view.rows.find((r) => r.ref === "base");
  if (!baseRow) return null;
  return (
    units.find(
      (u) => u.id != null && canonicalUnitRef(units, u.id) === "base" && u.label === baseRow.label,
    ) ?? null
  );
}

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

    // Stored refs name the level (SA-809); a legacy row that stored the factor-1 unit's id reads as "base".
    const asLevel = (ref: string | null): string | null =>
      ref == null ? null : canonicalUnitRef(units, ref);
    const tierOrderUnits: Partial<Record<2 | 3 | 4 | 5, string | null>> = {};
    for (const t of tierUnits) {
      if (t.tier >= 2 && t.tier <= 5)
        tierOrderUnits[t.tier as 2 | 3 | 4 | 5] = asLevel(t.orderUnitRef);
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
      { orderUnit: asLevel(product.orderUnitRef), tierOrderUnits, packAuto: product.packAuto },
    );
    const codes: ProductCodes = {
      sku: product.sku,
      barcode: product.barcode,
      unitSku: product.unitSku,
      // SA-809: the factor-1 row's code is keyed by the level ref "base", never by its ProductUnit id.
      unitCodes: Object.fromEntries(
        units.map((u) => [canonicalUnitRef(units, u.id), u.sku ?? null]),
      ),
    };
    const revision = Number(product.priceRevision) || 0;
    const priceState = computePriceState(product, units, tierUnits);
    const baseUnit = baseBackingUnit(units, view);
    const grid: ProductPriceGridDto = {
      productId,
      anchor: view.anchor,
      rows: priceGrid(view, rules).map((row) => {
        // A piece level no ProductUnit backs (the implicit row) cannot be priced: the write never mints a unit.
        const reason =
          governedReason(product) ??
          (row.ref === "base" && !baseUnit ? addUnitFirst(row.label) : null);
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
