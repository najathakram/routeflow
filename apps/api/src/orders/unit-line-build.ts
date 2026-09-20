import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PriceType } from "@prisma/client";
import {
  computeLineSubtotal,
  normalizeBoxesPieces,
  resolveUnitPrice,
  roundMoney,
  type LadderProduct,
  type LadderUnit,
} from "@routeflow/pricing";
import { lineUnitsPerBoxSnapshot, type ResolvedLineUnits } from "../products/line-units";

/**
 * units_v1, step 4b-2 — building ONE order line that is sold by a non-pack unit (a Case, a Pallet,
 * a Piece off a boxed pack). Pure (no DB, no Nest): `OrdersService.create()` resolves the unit with
 * `resolveLineUnits` (the ONE place a factor is decided), then hands the product, the ladder and
 * the request line here. The rules, all decided by the server and never by the client:
 *   - `qty` is a COUNT OF THE UNIT (3 = three Cases). `boxes`/`pieces` are refused: they are
 *     denominated in the pack, so accepting them beside a `unitLabel` would be two conflicting axes.
 *   - stored like a box-split line whose "box" is the unit: `boxes = count`, `pieces = 0`,
 *     `qty = count x factor` (base pieces — what stock, delivery and the invoice copy already read),
 *     `unitsPerBox = factor` (the snapshot a later rewrite keeps), `unitPrice` = price PER UNIT.
 *     A Piece off a boxed pack (factor 1) is a plain per-piece line that still snapshots factor 1.
 *   - price = the ladder price at the customer's tier, or the price staff typed (a one-time
 *     DISCOUNTED / upsell MANUAL against that ladder price). Promotions and a customer's remembered
 *     upsell price are keyed by pack pricing and apply to pack lines only (v1 ruling).
 */

export interface UnitLineRequest {
  productId: string;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  /** Staff-typed one-time price per unit (already gated to staff by the caller). */
  unitPrice?: number | null;
  unitLabel?: string | null;
  notes?: string | null;
  itemNote?: string | null;
}

/** The subset of `Product` a unit line reads (tracked-category snapshots + the ladder base). */
export interface UnitLineProduct extends LadderProduct {
  trackedCategoryId?: string | null;
  trackedSubcategoryId?: string | null;
}

/** true when the request asks to sell by a named unit (`""`/null/undefined = the pack). */
export const requestsUnit = (item: { unitLabel?: string | null } | null | undefined): boolean =>
  (item?.unitLabel ?? "").trim() !== "";

/**
 * Who may sell by a unit, and only under `flag.units_v1`. Nothing is consulted when no line asks
 * for a unit, so a tenant without the flag pays nothing and a pack-only request is byte-identical.
 * Buyers are refused: the buyer portal stays on the product's default unit (owner ruling).
 */
export async function assertMayUseUnits(
  items: ReadonlyArray<{ unitLabel?: string | null }>,
  ctx: {
    isStaff: boolean;
    tenantId: string | null | undefined;
    hasFlag: (tenantId: string, flag: string) => Promise<boolean>;
  },
): Promise<void> {
  if (!items.some(requestsUnit)) return;
  if (!ctx.isStaff) {
    throw new BadRequestException("Only staff can choose a selling unit on an order line.");
  }
  if (!ctx.tenantId || !(await ctx.hasFlag(ctx.tenantId, "flag.units_v1"))) {
    throw new ForbiddenException("Selling by unit is not included in this plan.");
  }
}

export interface UnitLineData {
  productId: string;
  name: null;
  qty: number;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  unitLabel: string;
  unitPrice: number;
  priceType: PriceType;
  originalPrice: number | null;
  promoFreeUnits: null;
  subtotal: number;
  notes: string | undefined;
  trackedCategoryId: string | null;
  trackedSubcategoryId: string | null;
  categoryTaxAmount: number;
}

export function buildUnitLine(input: {
  product: UnitLineProduct;
  units: readonly LadderUnit[];
  resolved: ResolvedLineUnits;
  item: UnitLineRequest;
  /** The customer's pricing tier for this product (1..5). */
  tier: number;
  /** Regulated per-category tax for a line of `qtyPieces` base pieces worth `subtotal`. */
  taxFor: (qtyPieces: number, subtotal: number) => number;
}): UnitLineData {
  const { product, units, resolved, item, tier, taxFor } = input;
  const label = resolved.unitLabel;
  if (label == null) throw new Error("buildUnitLine needs a unit-aware resolution, not the pack");
  if ((item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0) {
    throw new BadRequestException(
      `A line sold by the ${label} takes a quantity of ${label} units only — leave boxes and pieces out.`,
    );
  }
  const count = Math.trunc(Number(item.qty));
  if (!(count > 0)) {
    throw new BadRequestException(`Line quantity must be greater than zero (${label}).`);
  }

  const factor = resolved.unitsPerBox;
  const split =
    resolved.kind === "piece"
      ? { boxes: null, pieces: null, qty: count }
      : normalizeBoxesPieces({ boxes: count, pieces: 0, unitsPerBox: factor });

  const listPrice = resolveUnitPrice(product, units, label, tier);
  const typed = item.unitPrice != null ? roundMoney(item.unitPrice) : null; // round every write
  let unitPrice = listPrice;
  let priceType: PriceType = tier > 1 ? PriceType.SPECIAL : PriceType.STANDARD;
  let originalPrice: number | null = null;
  if (typed != null && typed < listPrice) {
    unitPrice = typed;
    priceType = PriceType.DISCOUNTED;
    originalPrice = listPrice;
  } else if (typed != null && typed > listPrice) {
    unitPrice = typed; // an operator selling above the ladder deliberately (MANUAL upsell)
    priceType = PriceType.MANUAL;
    originalPrice = listPrice;
  }

  const subtotal = computeLineSubtotal({
    unitPrice,
    qty: split.qty,
    boxes: split.boxes,
    pieces: split.pieces,
    unitsPerBox: factor,
  });

  return {
    productId: item.productId,
    name: null,
    qty: split.qty,
    boxes: split.boxes,
    pieces: split.pieces,
    unitsPerBox: lineUnitsPerBoxSnapshot(resolved, split.boxes, "boxed"),
    unitLabel: label,
    unitPrice,
    priceType,
    originalPrice,
    promoFreeUnits: null,
    subtotal,
    notes: item.itemNote || item.notes || undefined,
    trackedCategoryId: product.trackedCategoryId ?? null,
    trackedSubcategoryId: product.trackedSubcategoryId ?? null,
    categoryTaxAmount: taxFor(split.qty, subtotal),
  };
}
