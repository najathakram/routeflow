import { ConflictException } from "@nestjs/common";
import type { LadderUnit, TrackedCategoryRow } from "@routeflow/pricing";
import {
  assertMayUseUnits,
  buildUnitLine,
  categoryTaxForLine,
  loadUnitLadders,
  requestsUnit,
  type UnitLineProduct,
} from "./unit-line-build";
import type { ResolvedLineUnits } from "../products/line-units";
import { liveLines } from "./order-edit-cancelled";
import type { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import type { OrdersService } from "./orders.service";

/**
 * units_v1 (A1) — everything `updateOrderItems` needs to touch a unit-aware line, kept out of
 * `orders.service.ts` to fit its size ratchet. The method itself keeps exactly ONE literal call to
 * `resolveLineUnits` (the AST proof in `unit-line-writers.ast.spec.ts` only walks class methods,
 * B635) — resolved ONCE per dto item, up front, into a map; every write site below just reads its
 * own row back out, so a per-Case number can never be re-derived inconsistently at a second site
 * (the B606 shape).
 */

type LineLike = {
  id: string;
  productId?: string | null;
  unitLabel?: string | null;
  unitsPerBox?: number | null;
  status?: string | null;
};

export interface UnitEditContext {
  /** Every product a dto item or an existing line names, by id. */
  products: Map<string, any>;
  ladders: Map<string, LadderUnit[]>;
  existingById: Map<string, LineLike>;
}

/**
 * Pre-tx (mirrors the other reference reads updateOrderItems already hoists out of the
 * transaction): the staff+flag gate, then the ladder + minimal product row for every product a
 * dto item or an existing order line names — covers a bare `{id, qty}` UPDATE entry too, which
 * carries no productId of its own and must fall back to the existing line's.
 */
export async function prepareUnitEditContext(
  self: OrdersService,
  order: { lineItems: ReadonlyArray<LineLike> },
  dto: UpdateOrderItemsDto,
  user: { role?: string } | undefined,
): Promise<UnitEditContext> {
  const items = dto.items ?? [];
  await assertMayUseUnits(items, {
    isStaff: user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN",
    tenantId: self.prisma.getTenantId(),
    hasFlag: (t, f) => self.entitlements.hasFlag(t, f),
  });
  // SA-422b: live lines only — a CANCELLED line is never resolved as a unit line to edit.
  const existingById = new Map<string, LineLike>(
    liveLines(order.lineItems).map((li) => [li.id, li]),
  );
  // Nothing to resolve (the common case — no item names a unit, no existing line is one) reads
  // NOTHING new: a plain pack-only edit stays byte-identical to pre-A1, no extra query at all.
  const productIds = [
    ...new Set([
      ...order.lineItems.filter((li) => li.unitLabel != null).map((li) => li.productId),
      ...items.filter(requestsUnit).map((i) => i.productId),
      ...items.filter(requestsUnit).map((i) => i.substituteProductId),
    ]),
  ].filter((v): v is string => !!v);
  const db = self.prisma.forTenant();
  const products = productIds.length
    ? await db.product.findMany({ where: { id: { in: productIds } } })
    : [];
  return {
    products: new Map(products.map((p: any) => [p.id, p])),
    ladders: await loadUnitLadders(db, productIds),
    existingById,
  };
}

/**
 * The money seam: an edit that targets an existing unit-aware line (qty, price, or substitute —
 * never a bare CANCEL/DELETE/reason-only touch, which changes no money) MUST name that line's
 * unit; an item with no unitLabel aimed at one is REFUSED here, never silently interpreted against
 * either the held unit OR the pack — staff included. Named-and-different is allowed through (a
 * genuine re-denomination), resolved normally below.
 */
export function assertUnitLabelNamed(
  li: LineLike | undefined,
  item: {
    unitLabel?: string | null;
    qty?: number;
    boxes?: number | null;
    pieces?: number | null;
    unitPrice?: number;
    substituteProductId?: string;
  },
): void {
  const isSubstantiveEdit =
    item.qty !== undefined ||
    item.boxes != null ||
    item.pieces != null ||
    item.unitPrice !== undefined ||
    item.substituteProductId != null;
  if (li?.unitLabel != null && item.unitLabel === undefined && isSubstantiveEdit) {
    throw new ConflictException({
      code: "UNIT_AWARE_LINE",
      message: `This line is sold by the ${li.unitLabel} — name the unit to edit it (never interpreted as pieces).`,
    });
  }
}

export interface UnitWriteContext {
  tx: { orderItem: { create(a: any): Promise<unknown>; update(a: any): Promise<unknown> } };
  ladders: Map<string, LadderUnit[]>;
  tenantId: string | null | undefined;
  tier: (productId: string) => number;
  /** trackedCategoryId -> TrackedCategory row, for the products this edit touches (B297). */
  categoryMap: Map<string, TrackedCategoryRow>;
}

/**
 * B635: this function's own `tx.orderItem.create` call is itself invisible to
 * `unit-line-writers.ast.spec.ts`'s scanner — it only inspects methods inside a class. Filed, not
 * fixed here (do not widen the scanner in this PR); `updateOrderItems`'s literal `resolveLineUnits`
 * call is what the AST proof actually pins today.
 *
 * Replace-all create + diff-ADD (both create a brand-new order line).
 */
export async function createUnitLine(
  ctx: UnitWriteContext,
  orderId: string,
  product: UnitLineProduct & { id: string },
  resolved: ResolvedLineUnits,
  item: any,
  position: number,
): Promise<void> {
  // B297: price + stamp the trio at WRITE, like every other writer — a NULL/zero placeholder here
  // would become a PERMANENT $0 levy once PR 3's "keep the stored amount" rule reads it back.
  const category = product.trackedCategoryId
    ? ctx.categoryMap.get(product.trackedCategoryId)
    : null;
  const built = buildUnitLine({
    product,
    units: ctx.ladders.get(product.id) ?? [],
    resolved,
    item: { ...item, productId: product.id },
    tier: ctx.tier(product.id),
    taxFor: (qty, sub) => categoryTaxForLine(category, qty, sub),
    position,
    tenantId: ctx.tenantId,
  });
  await ctx.tx.orderItem.create({ data: { orderId, ...built } });
}

/**
 * SUBSTITUTE + the qty/price UPDATE of an existing line — same product or a new one.
 *
 * B297 (SA-098a b): `isSubstitute` decides the trio's fate — the two cases are NOT the same
 * writer. A SUBSTITUTE is, in substance, a new line (the product and its category changed), so it
 * re-stamps from the NEW product's category, same as `createUnitLine`. A same-product qty/price
 * edit is NOT a new sale, so the trio must never move — the 3 trio keys are stripped out of
 * `buildUnitLine`'s return before the Prisma call, so `data` never names them and the existing
 * columns are left untouched (Prisma only writes fields present in `data`). The amount still
 * prices from `product`'s own category either way (the unchanged product on a same-product edit,
 * the new one on a substitute) — harmless even for the same-product case, since
 * `recomputeLineCategoryTaxes` unconditionally overwrites every active line's amount from the
 * live category right after this transaction, same as it always has. Only the TRIO is the thing
 * this function must not touch on a same-product edit.
 */
export async function updateUnitLine(
  ctx: UnitWriteContext,
  lineId: string,
  product: UnitLineProduct & { id: string },
  resolved: ResolvedLineUnits,
  item: any,
  isSubstitute: boolean,
): Promise<void> {
  const category = product.trackedCategoryId
    ? ctx.categoryMap.get(product.trackedCategoryId)
    : null;
  const {
    position: _position,
    categoryTaxType,
    categoryTaxRate,
    categoryPriceIncludesTax,
    ...rest
  } = buildUnitLine({
    product,
    units: ctx.ladders.get(product.id) ?? [],
    resolved,
    item: { ...item, productId: product.id },
    tier: ctx.tier(product.id),
    taxFor: (qty, sub) => categoryTaxForLine(category, qty, sub),
    position: 0,
    tenantId: ctx.tenantId,
  });
  const data = isSubstitute
    ? { ...rest, categoryTaxType, categoryTaxRate, categoryPriceIncludesTax }
    : rest;
  await ctx.tx.orderItem.update({ where: { id: lineId }, data });
}
