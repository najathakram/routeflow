import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { LadderUnit, TrackedCategoryRow } from "@routeflow/pricing";
import {
  assertMayUseUnits,
  buildUnitLine,
  type StoredUnitLine,
  categoryTaxForLine,
  loadUnitLadders,
  requestsUnit,
  type UnitLineProduct,
} from "./unit-line-build";
import type { ResolvedLineUnits } from "../products/line-units";
import { liveLines } from "./order-edit-cancelled";
import { writeLineUpdate } from "./order-line-removal";
import type { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import type { OrdersService } from "./orders.service";
import { API_ERROR_CODES } from "../common/api-error-codes";

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
  // SA-422b(b): drop CANCELLED lines ONLY for the roles planCancelledLines refuses (CUSTOMER,
  // DRIVER) — it has already answered their edits of a cancelled id. EVERY other role (staff,
  // SUPER_ADMIN) and a missing principal keep every line (Opus delta items 6 + follow-up): the
  // lock-time map (heldById) keeps cancelled rows too, so dropping them here let an edit of a
  // cancelled Case line pass this pre-lock check, commit the linked-invoice revert, then 409.
  const refusedByPlan = user?.role === "CUSTOMER" || user?.role === "DRIVER";
  const existingById = new Map<string, LineLike>(
    (refusedByPlan ? liveLines(order.lineItems) : order.lineItems).map((li) => [li.id, li]),
  );
  // SA-407: a buyer's count edit KEEPS its line's own stored unit (the price basis fixed at order
  // time) — that is not choosing a unit, so it skips the staff-only gate. A buyer NAMING any other
  // unit was already refused 409 by the guard; staff keep the gate exactly as before.
  const isStaff = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  const keepsOwnUnit = (i: (typeof items)[number]) =>
    user?.role === "CUSTOMER" &&
    i.id != null &&
    i.unitLabel != null &&
    existingById.get(i.id)?.unitLabel === i.unitLabel;
  await assertMayUseUnits(isStaff ? items : items.filter((i) => !keepsOwnUnit(i)), {
    isStaff,
    tenantId: self.prisma.getTenantId(),
    hasFlag: (t, f) => self.entitlements.hasFlag(t, f),
  });
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
      code: API_ERROR_CODES.UNIT_AWARE_LINE,
      message: `This line is sold by the ${li.unitLabel} — name the unit to edit it (never interpreted as pieces).`,
    });
  }
}

/**
 * SA-474 (#2443): an edit that takes a held unit-aware line back to the PACK — `unitLabel: null`,
 * or the pack's own label, both resolve to a label-less pack row — is REFUSED, nothing written.
 * The pack branch would half-apply it: sized at the HELD factor, the held unit's price kept, the
 * label never cleared. A substitute is a new line and CANCEL/DELETE change no money, so both pass.
 * Re-denominating to the pack (priced from @routeflow/pricing) is the post-freeze feature.
 */
export function assertNoPackRedenomination(
  li: LineLike | undefined,
  item: { action?: string; substituteProductId?: string },
  resolved: ResolvedLineUnits | undefined,
): void {
  if (li?.unitLabel == null || resolved == null || resolved.unitLabel != null) return;
  if (item.substituteProductId != null || item.action === "CANCEL" || item.action === "DELETE")
    return;
  throw new ConflictException({
    code: API_ERROR_CODES.UNIT_AWARE_LINE,
    message: `This line is sold by the ${li.unitLabel} — switching it back to the pack isn't supported yet. Remove the line and re-add it.`,
  });
}

export interface UnitWriteContext {
  tx: {
    orderItem: { create(a: any): Promise<unknown>; update(a: any): Promise<unknown> };
  };
  /** #2577: the order being edited — every line rewrite is scoped to it. */
  orderId: string;
  ladders: Map<string, LadderUnit[]>;
  tenantId: string | null | undefined;
  tier: (productId: string) => number;
  /** H3: the acting staff user, stamped on a unit line whose typed price overrides the customer's price. */
  overriddenBy?: string | null;
  /** H3: the order's lines as held under the edit's row lock, by id: the stored side of a re-sent price. */
  held?: ReadonlyMap<string, unknown>;
  /** H3: the buyer's count diff re-prices a tier line at the current tier on a qty-only edit (SA-507b). */
  repriceTierOnQtyOnly?: boolean;
  /** trackedCategoryId -> TrackedCategory row, for the products this edit touches (B297). */
  categoryMap: Map<string, TrackedCategoryRow>;
}

/**
 * H3: the stored line a replace-all entry re-writes, per the ONE pairing helper (`sourceLineId`: by id, or
 * the strict same-product, same-unit fallback). The builder re-checks the unit; none = a new sale.
 */
export function pairedStoredLine(
  ctx: Pick<UnitWriteContext, "held">,
  item: { sourceLineId?: string },
  productId: string,
): StoredUnitLine | null {
  const line = item.sourceLineId ? ctx.held?.get(item.sourceLineId) : undefined;
  return line && (line as { productId?: string | null }).productId === productId
    ? (line as StoredUnitLine)
    : null;
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
    overriddenBy: ctx.overriddenBy,
    stored: pairedStoredLine(ctx, item, product.id),
  });
  // Row 373b: a line paired with a stored line (the ONE pairing helper sets `carriedLine`) keeps that line's
  // category, trio and createdAt: a re-created unit line is not a new sale.
  await ctx.tx.orderItem.create({
    data: {
      orderId,
      ...built,
      ...((item.carriedLine as Record<string, unknown> | undefined) ?? {}),
    },
  });
}

/**
 * SUBSTITUTE + the qty/price UPDATE of an existing line — same product or a new one.
 *
 * B297 (SA-098a b): `isSubstitute` decides the trio's fate — the two cases are NOT the same
 * writer. A SUBSTITUTE is, in substance, a new line (the product and its category changed), so it
 * re-stamps from the NEW product's category, same as `createUnitLine`. A same-product qty/price
 * edit is NOT a new sale, so the trio must never move — the 3 trio keys are stripped out of
 * `buildUnitLine`'s return before the Prisma call, so `data` never names them and the existing
 * columns are left untouched (Prisma only writes fields present in `data`). A SUBSTITUTE's amount prices
 * from the new product's category; on a same-product edit the amount is not written at all (row 338,
 * below): `recomputeLineCategoryTaxes` re-derives every active line's amount from the line's OWN rate
 * snapshot right after this transaction (B297 PR3; it was the live category before). Only the TRIO is the
 * thing this function must not touch on a same-product edit.
 * B297 row 338: a same-product edit also leaves `trackedCategoryId` / `trackedSubcategoryId` /
 * `categoryTaxAmount` untouched. They used to be written from the product's CURRENT category, so a product
 * that had left (or changed) its category re-filed the line and the recompute then priced it from a trio that
 * no longer matched, or dropped its sale-time excise. The line keeps the category it was sold under; its
 * amount is re-derived from its own snapshot by `recomputeLineCategoryTaxes` (a no-category line keeps its
 * stored levy, L1).
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
    // B297 row 338: the category the line was SOLD under (and its levy) belong to the line, not to the
    // product's CURRENT category; only a substitute (a new sale) takes the new product's.
    trackedCategoryId,
    trackedSubcategoryId,
    categoryTaxAmount,
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
    overriddenBy: ctx.overriddenBy,
    // a substitute is a new sale: judged against the tier price, never against the line it replaces
    stored: isSubstitute ? null : (ctx.held?.get(lineId) as StoredUnitLine | undefined),
    repriceTierOnQtyOnly: ctx.repriceTierOnQtyOnly,
  });
  const data = isSubstitute
    ? {
        ...rest,
        trackedCategoryId,
        trackedSubcategoryId,
        categoryTaxAmount,
        categoryTaxType,
        categoryTaxRate,
        categoryPriceIncludesTax,
      }
    : rest;
  await writeLineUpdate(ctx.tx, ctx.orderId, lineId, data); // #2577: { id, orderId }, never bare
}

/**
 * SA-407: a CUSTOMER's per-line diff runs the merge branch, not the replace branch that re-checks
 * ownership inside the transaction (REG-B131: `deletedAt: null` — a removed customer's still-valid
 * session must not mutate an order). The same check, for the merge branch. No-op for everyone else.
 */
export async function assertBuyerOwnsOrder(
  tx: { customer: { findFirst(a: any): Promise<{ id: string } | null> } },
  user: { role?: string; sub?: string } | undefined,
  customerId: string,
): Promise<void> {
  if (user?.role !== "CUSTOMER") return;
  const owner = await tx.customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
  if (!owner || owner.id !== customerId) throw new ForbiddenException();
}
