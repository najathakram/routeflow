import { ConflictException } from "@nestjs/common";
import { categoryTaxSnapshotOf, type LadderUnit } from "@routeflow/pricing";
import {
  assertMayUseUnits,
  buildUnitLine,
  loadUnitLadders,
  requestsUnit,
  type UnitLineProduct,
} from "./unit-line-build";
import type { ResolvedLineUnits } from "../products/line-units";
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
  const existingById = new Map<string, LineLike>(order.lineItems.map((li) => [li.id, li]));
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
  const built = buildUnitLine({
    product,
    units: ctx.ladders.get(product.id) ?? [],
    resolved,
    item: { ...item, productId: product.id },
    tier: ctx.tier(product.id),
    // The post-mutation recomputeLineCategoryTaxes pass fixes the amount for every line — the
    // snapshot is deferred the same way (B297), never stamped from a category read here that the
    // amount doesn't actually reflect yet.
    taxFor: () => ({ amount: 0, snapshot: categoryTaxSnapshotOf(null) }),
    position,
    tenantId: ctx.tenantId,
  });
  await ctx.tx.orderItem.create({ data: { orderId, ...built } });
}

/** SUBSTITUTE + the qty/price UPDATE of an existing line — same product or a new one. */
export async function updateUnitLine(
  ctx: UnitWriteContext,
  lineId: string,
  product: UnitLineProduct & { id: string },
  resolved: ResolvedLineUnits,
  item: any,
): Promise<void> {
  const { position: _position, ...built } = buildUnitLine({
    product,
    units: ctx.ladders.get(product.id) ?? [],
    resolved,
    item: { ...item, productId: product.id },
    tier: ctx.tier(product.id),
    // Same deferral as createUnitLine above — see its comment.
    taxFor: () => ({ amount: 0, snapshot: categoryTaxSnapshotOf(null) }),
    position: 0,
    tenantId: ctx.tenantId,
  });
  await ctx.tx.orderItem.update({ where: { id: lineId }, data: built });
}
