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
 */
import { OrderStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { billsAtShipment, carrierCancelBlockedReason } from "./order-status-invoicing";
import { lastShipStateSource } from "./order-ship-state";

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
