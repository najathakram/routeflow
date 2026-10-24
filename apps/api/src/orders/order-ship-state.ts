/**
 * Marker revisions that tell a deliberate UNMARK from a REOPEN after delivery (there is no order status
 * history table, and `shippedAt` survives both, by design: E-c's "no second shipped email").
 *
 * For a carrier (SHIP) order, `changeStatus` appends one `OrderRevision` with a marker `source` on:
 *  - OUT_FOR_DELIVERY -> CONFIRMED ("Unmark shipped"): the parcel never left, so a later cancel is fine
 *    (after ANY delivery it records a reopen instead: the rest is still out, #3219 S1);
 *  - DELIVERED -> CONFIRMED / PARTIALLY_DELIVERED (a reopen): the goods went out, so the order is
 *    "with the carrier" again and is not cancelled (`carrierCancelBlockedReason`).
 * The LAST marker decides. `OrderRevision.source` is a free string (not a Prisma enum): no migration.
 * Written only for a business that bills at shipment (the only one the guard reads them for), and kept
 * out of the order's edit history (`SHIP_STATE_SOURCES`): a marker is not an edit.
 *
 * ATOMIC (SA-689): the marker is written INSIDE the status transaction (`updateStatusWithShipMarker`), so
 * the two commit or roll back together. A lost REOPENED marker would read as "unmarked" and fail OPEN (the
 * order becomes cancellable, deletable or demotable while its goods are out), so a marker that cannot be
 * written fails the status change instead; the operator retries.
 *
 * KNOWN: legacy reopen without marker. A reopen from DELIVERED that happened BEFORE markers existed has
 * none, so it reads as unmarked: cancellable. There is no status history to rebuild it from (and
 * `shippedAt` survives an unmark too), so this is accepted and pinned in `carrier-cancel.spec.ts`.
 *
 * The marker constants live in `ship-state-markers.ts` (a leaf), so `order-status-invoicing.ts`, which
 * this file imports, can read them without importing this file back (SA-689 b).
 */
import { FulfillPath, OrderStatus } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";
import { appendOrderRevisionInTx } from "./order-revisions";
import { type buildStatusUpdateData, writeStatusIfUnchanged } from "./order-status-claim";
import { billsAtShipment } from "./order-status-invoicing";
import { stampDeliveredInFull } from "./delivered-stamp";
import { completeOfficeEvidencedLines } from "./office-evidence-completion";
import {
  type OfficeDeliveryLine,
  leavePartialDeliveryInTx,
  recordPartialDeliveryInTx,
} from "./order-pd-quantities";
import { SHIP_STATE_REOPENED, SHIP_STATE_SOURCES, SHIP_STATE_UNMARKED } from "./ship-state-markers";

export {
  EDIT_REVISIONS,
  SHIP_STATE_REOPENED,
  SHIP_STATE_SOURCES,
  SHIP_STATE_UNMARKED,
} from "./ship-state-markers";

type ShipStateDeps = {
  prisma: PrismaService;
  featureConfig?: Parameters<typeof billsAtShipment>[0];
};

/** The marker a status change leaves (SHIP orders only), or null when it is not one. */
export function shipStateMarker(
  fulfillPath: FulfillPath,
  from: OrderStatus,
  to: OrderStatus,
): string | null {
  if (fulfillPath !== FulfillPath.SHIP) return null;
  if (from === OrderStatus.OUT_FOR_DELIVERY && to === OrderStatus.CONFIRMED)
    return SHIP_STATE_UNMARKED;
  if (
    from === OrderStatus.DELIVERED &&
    (to === OrderStatus.CONFIRMED || to === OrderStatus.PARTIALLY_DELIVERED)
  ) {
    return SHIP_STATE_REOPENED;
  }
  return null;
}

type ShipStateOrder = {
  id: string;
  tenantId?: string | null;
  status: OrderStatus;
  fulfillPath: FulfillPath;
  subtotal: unknown;
  tax: unknown;
  total: unknown;
};

/**
 * Write an order's status change and, when it is a ship-state change (SHIP orders of a business that bills
 * at shipment), its marker, in ONE transaction. Any other change is the plain update it always was. The
 * marker is never best-effort: if it cannot be written the status change rolls back with it (SA-689).
 * Both paths write the status as the B1095 compare-and-set (`writeStatusIfUnchanged`, on the status the
 * transition was validated against): a lost CAS is the 409 ORDER_CHANGED_DURING_EDIT and, on the marked
 * path, throws BEFORE the marker, so a status that did not change leaves no marker.
 */
export async function updateStatusWithShipMarker(
  { prisma, featureConfig }: ShipStateDeps,
  order: ShipStateOrder,
  {
    status: to,
    reason,
    deliveries,
  }: { status: OrderStatus; reason?: string | null; deliveries?: readonly OfficeDeliveryLine[] },
  user: JwtPayload | undefined,
  data: ReturnType<typeof buildStatusUpdateData>,
) {
  const source = shipStateMarker(order.fulfillPath, order.status, to);
  if (
    !source ||
    !(await billsAtShipment(featureConfig, order.tenantId ?? prisma.getTenantId(), order))
  ) {
    if (to === OrderStatus.PARTIALLY_DELIVERED) {
      // B692: a manual PARTIALLY_DELIVERED books its per-line quantities (or refuses) in the SAME tx as the status.
      return prisma.tenantTransaction(async (tx) => {
        const row = await writeStatusIfUnchanged(tx, order.id, order.status, data);
        await recordPartialDeliveryInTx(tx, order.id, deliveries);
        return row;
      });
    }
    // Depends on shipStateMarker(PARTIALLY_DELIVERED -> OUT_FOR_DELIVERY) being null (pinned in b692-office-pd-quantities.spec.ts).
    if (order.status === OrderStatus.PARTIALLY_DELIVERED && to === OrderStatus.OUT_FOR_DELIVERY) {
      // B692: "Back out for delivery" on a legacy PD row (no quantities) is refused in the SAME tx as the status.
      return prisma.tenantTransaction(async (tx) => {
        const row = await writeStatusIfUnchanged(tx, order.id, order.status, data);
        await leavePartialDeliveryInTx(tx, order.id, deliveries);
        return row;
      });
    }
    if (to !== OrderStatus.DELIVERED) {
      return writeStatusIfUnchanged(prisma.forTenant(), order.id, order.status, data);
    }
    // SA-763r: a manual DELIVERED books what left, in the SAME tx as the status write (no ship marker here).
    return prisma.tenantTransaction(async (tx) => {
      const row = await writeStatusIfUnchanged(tx, order.id, order.status, data);
      await stampDeliveredInFull(tx, order.id, "entry");
      // Row 587 (SA-833): the lines the office recorded as partly delivered are completed, audited, and named in the response.
      const officeCompletedLines = await completeOfficeEvidencedLines(tx, order.id, {
        tenantId: order.tenantId ?? prisma.getTenantId(),
        userId: user?.sub ?? null,
        impersonatedBy: user?.impersonatedBy ?? null,
      });
      return officeCompletedLines.length ? { ...row, officeCompletedLines } : row;
    });
  }
  return prisma.tenantTransaction(async (tx) => {
    const row = await writeStatusIfUnchanged(tx, order.id, order.status, data);
    if (to === OrderStatus.PARTIALLY_DELIVERED)
      await recordPartialDeliveryInTx(tx, order.id, deliveries);
    // #3219 S1 (lead ruling): after ANY delivery, "Unmark shipped" never makes the order cancellable
    // again (the rest is still with the carrier): it records a reopen. Read in this transaction; a failed
    // read fails the change (closed), it is never guessed.
    const delivered =
      source === SHIP_STATE_UNMARKED &&
      (await tx.orderItem.findFirst({
        where: { orderId: order.id, deliveredQty: { gt: 0 } },
        select: { id: true },
      })) != null;
    await appendOrderRevisionInTx(
      tx,
      prisma.getTenantId(),
      order.id,
      user,
      { subtotal: Number(order.subtotal), tax: Number(order.tax), total: Number(order.total) },
      delivered ? SHIP_STATE_REOPENED : source,
      reason,
    );
    return row;
  });
}

/** The source of the LAST ship-state marker on the order, or null when there is none. */
export async function lastShipStateSource(
  prisma: Pick<PrismaService, "forTenant">,
  orderId: string,
): Promise<string | null> {
  const row = await prisma.forTenant().orderRevision.findFirst({
    where: { orderId, source: { in: SHIP_STATE_SOURCES } },
    orderBy: { revisionNumber: "desc" },
    select: { source: true },
  });
  return row?.source ?? null;
}
