/**
 * B1082 / B1083: the carrier guard's call shapes, lifted out of `OrdersService` (it sits at its size cap).
 * The predicate itself is `carrierCancelBlockedReason` (order-status-invoicing.ts).
 *
 *  - `carrierBlocked`: the cancel / delete / DRAFT-demotion / findOne read.
 *  - `carrierEditGuard`: computed ONCE, before any write of an item edit (#3207 review D2/D6). The linked
 *    invoice revert commits on its own connection, so a with-carrier order must be known before it runs;
 *    and its config + marker reads stay on pool connections OUTSIDE the edit's interactive transaction.
 *  - `blockCreditsUnderLock`: the reduction guard re-read under the Order row lock, so a "Mark shipped"
 *    committing between the pre-transaction read and the lock cannot let one reduction through.
 *  - `carrierRevertUnderLock` (#3219 S2): for a ship-billing order the edit's invoice revert runs under
 *    that same lock, AFTER the re-read, so an order shipped mid-edit is refused with nothing reverted
 *    (never reverted on its own connection and then refused, stranding the shipment invoice in DRAFT).
 *  - `throwIfInTransitUnderLock` (#3219 S5): the cancel transaction's twin of the same re-read.
 *  - `throwIfWithCarrierChangeRequest` / `buyerEditClosedMessage` (B1135): the buyer-facing answers for a
 *    with-carrier order. SA-696 freezes its lines, so there is no change-request flow to point at.
 */
import { ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PrismaService } from "../prisma/prisma.service";
import {
  billsAtShipment,
  carrierCancelBlockedReason,
  throwIfWithCarrier,
} from "./order-status-invoicing";
import { lastShipStateSource } from "./order-ship-state";
import { holdsLiveDeliveredLine } from "./delivered-line-lock";
import { BUYER_EDIT_CLOSED_STATUSES } from "./edit-window";
import {
  BUYER_EDIT_CLOSED_DELIVERED_MESSAGE,
  ORDER_CHANGED_DURING_EDIT_MESSAGE,
} from "./delivered-line-copy";

/** The two `OrdersService` fields the guard reads (the service passes itself). */
type CarrierDeps = {
  featureConfig?: Parameters<typeof billsAtShipment>[0];
  prisma: Pick<PrismaService, "forTenant">;
};
export type CarrierOrder = Parameters<typeof carrierCancelBlockedReason>[2] & {
  tenantId?: string | null;
};

export function carrierBlocked({ featureConfig, prisma }: CarrierDeps, order: CarrierOrder) {
  return carrierCancelBlockedReason(featureConfig, order.tenantId, order, (id) =>
    lastShipStateSource(prisma, id),
  );
}

/**
 * B1135: the one buyer-facing sentence for a with-carrier order (the change-request 409 and the buyer's
 * edit 403). A literal copy of `SHIPPED_ORDER_MESSAGE` in packages/types (this app never value-imports
 * that package at runtime); common/shipped-order-message-parity.spec.ts pins the two byte-equal.
 */
export const SHIPPED_ORDER_MESSAGE =
  "This order has already shipped. Contact the seller for changes.";

/** W-1189: the buyer's refused edit of an order that was refused at the door. */
export const REFUSED_ORDER_MESSAGE =
  "This order was refused at delivery and can no longer be changed. Contact the seller.";

/**
 * B1135: a change request on a with-carrier order is refused with its own code. A carrier (SHIP) order has
 * no route run, so the G7 gate would otherwise answer "still directly editable" while the buyer's edit
 * answered "send a change request": a loop with no way out. Nothing here for a route-run order.
 */
export async function throwIfWithCarrierChangeRequest(
  deps: CarrierDeps,
  order: CarrierOrder,
): Promise<void> {
  if ((await carrierBlocked(deps, order)) === null) return;
  throw new ConflictException({
    code: API_ERROR_CODES.ORDER_WITH_CARRIER_NO_CHANGE_REQUEST,
    message: SHIPPED_ORDER_MESSAGE,
  });
}

/** B1135: the message of the buyer's refused post-dispatch edit: it names the exit that exists. */
export async function buyerEditClosedMessage(
  deps: CarrierDeps,
  order: CarrierOrder,
): Promise<string> {
  // W-1189: a refused order is not "out for delivery", and a change request cannot change it
  if ((order as { status?: string }).status === "REFUSED") return REFUSED_ORDER_MESSAGE;
  if ((await carrierBlocked(deps, order)) !== null) return SHIPPED_ORDER_MESSAGE;
  // SA-1544 P-5: closed by the delivered goods it holds, not by dispatch (a reopened order is CONFIRMED again)
  const { status, lineItems } = order as {
    status?: string;
    lineItems?: Array<{ status?: unknown; deliveredQty?: unknown }>;
  };
  if (
    !BUYER_EDIT_CLOSED_STATUSES.includes(status as OrderStatus) &&
    holdsLiveDeliveredLine(lineItems)
  )
    return BUYER_EDIT_CLOSED_DELIVERED_MESSAGE;
  return "This order is already out for delivery. Send a change request instead.";
}

export interface CarrierEditGuard {
  /** The order is with the carrier now: reductions are refused, the shipment invoice is not reverted. */
  withCarrier: boolean;
  /** The order is billed at shipment: an in-transit status found under the lock also blocks. */
  billsShip: boolean;
}

export async function carrierEditGuard(
  deps: CarrierDeps,
  order: CarrierOrder,
): Promise<CarrierEditGuard> {
  const billsShip = await billsAtShipment(deps.featureConfig, order.tenantId, order);
  if (!billsShip) return { withCarrier: false, billsShip };
  return { withCarrier: (await carrierBlocked(deps, order)) !== null, billsShip };
}

/**
 * B215: the statuses whose linked invoice(s) are re-synced IN PLACE after an item edit
 * (`postDeliveryEdit`) instead of reconciled as an open pending-mirror draft.
 */
const POST_DELIVERY_EDIT_STATUSES: ReadonlySet<string> = new Set([
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.PARTIALLY_DELIVERED,
  OrderStatus.DELIVERED,
]);

/**
 * The ONE routing rule for an edit's invoice reconcile, read by `updateOrderItems` AND by
 * `replayMergeReconcile`, so a replayed merge routes exactly as the fold that landed did (B215:
 * the two may not drift). A with-carrier order re-syncs its shipment invoice in place (D2 / S4).
 */
export function resyncsInPlace(
  status: string,
  guard: CarrierEditGuard,
  /**
   * SA-1506 PR-1a (B4): the order HOLDS a live delivered line (`isLiveDeliveredLine`, computed on the HELD lines). A
   * reopened order (CONFIRMED / PENDING again) that still carries delivered goods restates its invoice in place, like a
   * DELIVERED one (B215), instead of flipping to PENDING and reverting the invoice to a draft. REQUIRED, so the compiler
   * makes every caller say what it knows (the edit, replace-after-delivery, the merge replay, the revert set).
   */
  holdsLiveDelivered: boolean,
): boolean {
  return POST_DELIVERY_EDIT_STATUSES.has(status) || guard.withCarrier || holdsLiveDelivered;
}

/**
 * SA-1544 (ao): the edit is routed in place BY the held lines alone: neither the status nor the carrier already routed it,
 * so no old edit moves. One named export beside the rule, never a second call of `resyncsInPlace` with `false`.
 */
export function routedByHeldLines(
  status: string,
  guard: CarrierEditGuard,
  held: ReadonlyArray<{ status?: unknown; deliveredQty?: unknown }>,
): boolean {
  return holdsLiveDeliveredLine(held) && !resyncsInPlace(status, guard, false);
}

/**
 * SA-1544 (ap) / A9 9.3 item 8: the routing input (does the order HOLD a live delivered line) was read before the
 * transaction; it is recomputed on the LOCKED held lines for EVERY role and a difference is a 409, nothing written.
 * Same shape as `carrierRevertUnderLock`: call it right after `lockEditedOrder`, before the first write.
 */
export function routingUnderLock(
  preHolds: boolean,
  heldLocked: ReadonlyArray<{ status?: unknown; deliveredQty?: unknown }>,
): void {
  if (holdsLiveDeliveredLine(heldLocked) === preHolds) return;
  throw new ConflictException({
    code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
    message: ORDER_CHANGED_DURING_EDIT_MESSAGE,
  });
}

const IN_TRANSIT: ReadonlySet<string> = new Set([
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.PARTIALLY_DELIVERED,
]);

/** `blockCredits` for `settleStockForEdit`, read on `tx` after `SELECT … FOR UPDATE` on the order. */
export async function blockCreditsUnderLock(
  tx: { order: { findUnique(args: unknown): Promise<{ status: string } | null> } },
  orderId: string,
  guard: CarrierEditGuard,
): Promise<boolean> {
  if (guard.withCarrier) return true;
  if (!guard.billsShip) return false; // never a read for a tenant that does not bill at shipment
  const fresh = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
  return !!fresh && IN_TRANSIT.has(fresh.status);
}

/**
 * #3219 S2: the edit's `blockCredits`, read under the lock, plus (not post-delivery) the invoice revert in the SAME
 * transaction. Shipped since the pre-read: a coded 409, nothing reverted. Row 586: this is now every non-post-delivery
 * edit's revert (the pre-tx call is a read-only preflight), so a later binding refusal rolls it back.
 */
export async function carrierRevertUnderLock(
  tx: Parameters<typeof blockCreditsUnderLock>[0],
  orderId: string,
  guard: CarrierEditGuard,
  postDeliveryEdit: boolean,
  revert: () => Promise<unknown>,
): Promise<boolean> {
  const blocked = await blockCreditsUnderLock(tx, orderId, guard);
  if (postDeliveryEdit) return blocked;
  if (blocked) {
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message: "This order was shipped while you were editing it. Refresh and try again.",
    });
  }
  await revert();
  return false;
}

/** #3219 S5: a cancel that finds the order in transit under its lock is refused like the pre-check. */
export function throwIfInTransitUnderLock(
  guard: CarrierEditGuard | null,
  lockedStatus: string,
): void {
  if (guard?.billsShip && IN_TRANSIT.has(lockedStatus)) throwIfWithCarrier("WITH_CARRIER");
}
