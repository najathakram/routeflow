import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { orderEditMode } from "./order-edit-restrictions";
import { roundMoney } from "@routeflow/pricing";
import { assertWalkInSaleEditable } from "./counter-sale/walk-in-sale-lock";
import * as carrierGuard from "./order-carrier-guard";

export { walkInSaleLocked } from "./counter-sale/walk-in-sale-lock";

/**
 * W-871 (SA-948 §2 MUST 1): a replace deletes every line of the order and re-creates it. Each
 * `InvoiceItem.orderItemId` is `onDelete: SetNull`, so on a post-delivery order the invoice's lines lose their
 * provenance, the in-place re-sync (R1) cannot restate them, and the invoice stays at its old total. So a replace
 * (staff replace-all, a driver's full-list save) on a post-delivery order is refused before any write. The mode is
 * the ONE edit-mode predicate the delivered-line lock reads; `postDeliveryEdit` is updateOrderItems' own routing
 * (`carrierGuard.resyncsInPlace`). Per-line edits keep R1.
 */
export const LINES_REPLACE_AFTER_DELIVERY_MESSAGE =
  "This order has been delivered. Change its lines one at a time.";

export function assertNoReplaceAfterDelivery(
  postDeliveryEdit: boolean,
  user: { role?: string } | undefined,
  dto: { replaceAll?: boolean },
  isDiffPayload: boolean,
): void {
  if (!postDeliveryEdit) return;
  if (orderEditMode(user?.role, dto.replaceAll, isDiffPayload).kind !== "replace") return;
  throw new ConflictException({
    code: API_ERROR_CODES.LINES_REPLACE_AFTER_DELIVERY,
    message: LINES_REPLACE_AFTER_DELIVERY_MESSAGE,
  });
}

/** The walk-in flag, read alone: the order row the caller holds does not select its customer. */
const WALK_IN_FLAG = { customer: { select: { isWalkIn: true } } } as const;

/**
 * updateOrderItems' one call, before any write: the carrier routing (B1083 D2, B215), W-861's paid walk-in lock first
 * (SA-948 §2 MUST 3: a walk-in gets WALK_IN_SALE_PAID), then the W-871 replace refusal (a named customer's paid sale).
 * Returns the routing the edit goes on to use.
 */
type CarrierArgs = Parameters<typeof carrierGuard.carrierEditGuard>;

export async function editGuards(
  deps: CarrierArgs[0] & { prisma: { forTenant(): any } },
  order: CarrierArgs[1] & { id: string; status: string },
  user: { role?: string } | undefined,
  dto: { replaceAll?: boolean },
  isDiffPayload: boolean,
) {
  const carrier = await carrierGuard.carrierEditGuard(deps, order);
  const postDeliveryEdit = carrierGuard.resyncsInPlace(order.status, carrier);
  const db = deps.prisma.forTenant();
  const flag = await db.order.findUnique({ where: { id: order.id }, select: WALK_IN_FLAG });
  await assertWalkInSaleEditable(db, { id: order.id, customer: flag?.customer });
  assertNoReplaceAfterDelivery(postDeliveryEdit, user, dto, isDiffPayload);
  return { carrier, postDeliveryEdit };
}

/**
 * The edit tx's first move (SA-944 §3, SA-956 Fix 1): lock the Order row, then re-check the paid walk-in refusal under
 * it (a payment can commit between `editGuards` and the lock; this read sees every one), and return the order's
 * total BEFORE this edit writes (NaN when the row cannot be read: the overpay fallback then fails closed).
 */
export async function lockEditedOrder(tx: any, orderId: string): Promise<number> {
  await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  const row = await tx.order.findUnique({
    where: { id: orderId },
    select: { total: true, ...WALK_IN_FLAG },
  });
  await assertWalkInSaleEditable(tx, { id: orderId, customer: row?.customer });
  const n = Number(row?.total);
  return Number.isFinite(n) ? roundMoney(n) : Number.NaN;
}
