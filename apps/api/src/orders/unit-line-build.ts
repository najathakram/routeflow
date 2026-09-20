import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PriceType } from "@prisma/client";
import {
  InvalidTierError,
  computeCategoryTax,
  computeLineSubtotal,
  normalizeBoxesPieces,
  resolveUnitPrice,
  type CategoryTaxType,
  type LadderProduct,
  type LadderUnit,
  roundMoney,
} from "@routeflow/pricing";
import { lineUnitsPerBoxSnapshot, type ResolvedLineUnits } from "../products/line-units";

/**
 * units_v1, step 4b-2 — building ONE order line that is sold by a non-pack unit (a Case, a Pallet,
 * a Piece off a boxed pack). Pure (no DB, no Nest): `OrdersService.create()` resolves the unit with
 * `resolveLineUnits` (the ONE place a factor is decided), then hands the product, the ladder and
 * the request line here. The rules, all decided by the server and never by the client:
 *   - CONTRACT: only a unit-aware resolution (`isUnitAware`) is built here. The pack's own label
 *     ("Box") and a "Piece" on a product with no pack size resolve to the PACK (`unitLabel` null) —
 *     the caller keeps those on its existing pack branch, never here.
 *   - `qty` is a COUNT OF THE UNIT (3 = three Cases). `boxes`/`pieces` are refused: they are
 *     denominated in the pack, so accepting them beside a `unitLabel` would be two conflicting axes.
 *   - stored like a box-split line whose "box" is the unit: `boxes = count`, `pieces = 0`,
 *     `qty = count x factor` (base pieces — what stock, delivery and the invoice copy already read),
 *     `unitsPerBox = factor` (the snapshot a later rewrite keeps), `unitPrice` = price PER UNIT.
 *     A factor-1 unit (a Piece off a boxed pack) is a plain per-piece line that still snapshots 1.
 *   - price mirrors the pack branch: a staff-typed price BELOW the tier-1 unit price is DISCOUNTED,
 *     ABOVE it a MANUAL upsell (both keep the tier-1 unit price as `originalPrice`); otherwise the
 *     ladder price at the customer's tier — STANDARD at tier 1, SPECIAL (original = tier-1 price)
 *     otherwise. Promotions and a customer's remembered upsell price are keyed by pack pricing and
 *     apply to pack lines only (v1 ruling).
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

/** A Prisma `Decimal` (or number/string) — coerced once by `toLadderProduct`. */
type Money = number | string | { toString(): string };

/** The subset of `Product` a unit line reads (tracked-category snapshots + the ladder base). */
export interface UnitLineProduct {
  unit?: string | null;
  unitsPerBox?: number | null;
  pricePerUnit: Money;
  priceTier2?: Money | null;
  priceTier3?: Money | null;
  priceTier4?: Money | null;
  priceTier5?: Money | null;
  trackedCategoryId?: string | null;
  trackedSubcategoryId?: string | null;
}

const str = (v: Money | null | undefined): string | null => (v == null ? null : String(v));
const toLadderProduct = (p: UnitLineProduct): LadderProduct => ({
  unit: p.unit,
  unitsPerBox: p.unitsPerBox,
  pricePerUnit: String(p.pricePerUnit),
  priceTier2: str(p.priceTier2),
  priceTier3: str(p.priceTier3),
  priceTier4: str(p.priceTier4),
  priceTier5: str(p.priceTier5),
});

/** true when the request asks to sell by a named unit (`""`/null/undefined = the pack). */
export const requestsUnit = (item: { unitLabel?: string | null } | null | undefined): boolean =>
  (item?.unitLabel ?? "").trim() !== "";

/** true when `resolveLineUnits` decided this line is NOT the pack — the only lines built here. */
export const isUnitAware = (resolved: ResolvedLineUnits): boolean => resolved.unitLabel != null;

/**
 * Who may sell by a unit, and only under `flag.units_v1`. Nothing is consulted when no line asks
 * for a unit, so a tenant without the flag pays nothing and a pack-only request is byte-identical.
 * Buyers are refused: the buyer portal stays on the product's default unit (owner ruling). A custom
 * (unlisted) line has no ladder, so a unit on one is refused rather than silently dropped.
 */
export async function assertMayUseUnits(
  items: ReadonlyArray<{ unitLabel?: string | null; productId?: string | null }>,
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
  if (items.some((i) => requestsUnit(i) && !i.productId)) {
    throw new BadRequestException("A custom line has no selling units — pick a catalog product.");
  }
  if (!ctx.tenantId || !(await ctx.hasFlag(ctx.tenantId, "flag.units_v1"))) {
    throw new ForbiddenException("Selling by unit is not included in this plan.");
  }
}

/**
 * The server ladder (ProductUnit rows) of the given products, grouped by product. `db` is the
 * TENANT-SCOPED client (`prisma.forTenant()`), so a foreign product id can never read another
 * tenant's levels. No ids = no query.
 */
export async function loadUnitLadders(
  db: { productUnit: { findMany(args: any): Promise<any[]> } },
  productIds: ReadonlyArray<string>,
): Promise<Map<string, LadderUnit[]>> {
  const ids = [...new Set(productIds.filter(Boolean))];
  const out = new Map<string, LadderUnit[]>();
  if (ids.length === 0) return out;
  const rows = await db.productUnit.findMany({
    where: { productId: { in: ids } },
    orderBy: { sortOrder: "asc" },
  });
  for (const r of rows) {
    const list = out.get(r.productId) ?? [];
    list.push(r as LadderUnit);
    out.set(r.productId, list);
  }
  return out;
}

/**
 * `OrdersService.create()` in ONE call: the gate (who may sell by a unit, under flag.units_v1) and
 * the server ladder of every product a line names a unit for. Reads nothing when no line asks.
 */
export async function prepareUnitLadders(
  items: ReadonlyArray<{ unitLabel?: string | null; productId?: string | null }>,
  ctx: {
    isStaff: boolean;
    prisma: { getTenantId(): string | null | undefined; forTenant(): any };
    entitlements: { hasFlag(tenantId: string, flag: string): Promise<boolean> };
  },
): Promise<Map<string, LadderUnit[]>> {
  await assertMayUseUnits(items, {
    isStaff: ctx.isStaff,
    tenantId: ctx.prisma.getTenantId(),
    hasFlag: (t, f) => ctx.entitlements.hasFlag(t, f),
  });
  return loadUnitLadders(
    ctx.prisma.forTenant(),
    items.filter(requestsUnit).map((i) => i.productId as string),
  );
}

/**
 * One line's identity in the Idempotency-Key replay comparison. A unit line's REQUEST qty counts the
 * unit (3 = three Cases) while the STORED qty is base pieces, so a stored unit line compares by its
 * unit count (`boxes ?? qty`) and carries its label; a pack line's key is unchanged.
 */
export function replayLineKey(
  r: {
    productId?: string | null;
    name?: string | null;
    qty: unknown;
    boxes?: unknown;
    unitLabel?: string | null;
  },
  stored: boolean,
): string {
  const unit = (r.unitLabel ?? "").trim().toLowerCase();
  const count = stored && unit ? (r.boxes ?? r.qty) : r.qty;
  return `${r.productId ?? `unlisted:${r.name ?? ""}`}×${Number(count)}${unit ? `@${unit}` : ""}`;
}

/** Regulated per-category tax for a unit line (0 when the product has no tracked category). */
export const categoryTaxForLine = (
  category: { taxType: unknown; rate: unknown; priceIncludesTax: boolean } | null | undefined,
  qtyPieces: number,
  lineSubtotal: number,
): number =>
  category
    ? computeCategoryTax({
        taxType: category.taxType as CategoryTaxType,
        rate: Number(category.rate),
        unitBasisQty: qtyPieces,
        lineSubtotal,
        priceIncludesTax: category.priceIncludesTax,
      })
    : 0;

/** OrderItem.qty is Decimal(10,3) and subtotal Decimal(10,2): a bigger line would 500 the order. */
export const MAX_LINE_QTY = 9_999_999;
export const MAX_LINE_SUBTOTAL = 99_999_999.99;

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
  position: number;
  tenantId: string | null | undefined;
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
  /** Set on every line by the caller's tenancy: a nested create bypasses `forTenant()`. */
  position: number;
  tenantId: string | null | undefined;
}): UnitLineData {
  const { product, units, resolved, item, tier, taxFor } = input;
  const ladderProduct = toLadderProduct(product);
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
  const baseQty = count * factor;
  if (baseQty > MAX_LINE_QTY) {
    throw new BadRequestException(
      `${count} x ${label} is ${baseQty.toLocaleString("en-US")} pieces — over the ${MAX_LINE_QTY.toLocaleString("en-US")} a single line can hold.`,
    );
  }
  const split =
    factor === 1
      ? { boxes: null, pieces: null, qty: count }
      : normalizeBoxesPieces({ boxes: count, pieces: 0, unitsPerBox: factor });

  let listPrice: number;
  let tierPrice: number;
  try {
    listPrice = resolveUnitPrice(ladderProduct, units, label, 1);
    tierPrice = resolveUnitPrice(ladderProduct, units, label, tier);
  } catch (e) {
    if (e instanceof InvalidTierError) {
      throw new BadRequestException(
        "This customer's pricing tier is invalid (must be 1-5) — fix it on the customer first.",
      );
    }
    throw e;
  }
  const typed = item.unitPrice != null ? roundMoney(item.unitPrice) : null; // round every write
  let unitPrice = tierPrice;
  let priceType: PriceType = tier !== 1 ? PriceType.SPECIAL : PriceType.STANDARD;
  let originalPrice: number | null = tier !== 1 ? listPrice : null;
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
  if (subtotal > MAX_LINE_SUBTOTAL) {
    throw new BadRequestException(
      `This line's total is over the ${MAX_LINE_SUBTOTAL} one line can hold.`,
    );
  }

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
    position: input.position,
    tenantId: input.tenantId,
  };
}
