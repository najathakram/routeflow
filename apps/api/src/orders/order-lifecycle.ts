/**
 * Order lifecycle edits — lifted VERBATIM out of `OrdersService` (size-ratchet headroom: the
 * units_v1 by-file conversions (A1, `updateOrderItems`) and #1124 (`approveChangeRequestAtStop`,
 * door edits) both need to grow `orders.service.ts`, which sits at its size-ratchet cap. Neither
 * touches this region, so it is a safe verbatim extraction. No behaviour change: every body below
 * is byte-identical to the method it replaces except `this.` → `self.` (a class instance is now
 * passed explicitly instead of implicitly bound) — the class keeps thin same-signature delegators
 * (mirrors `buyer-merge-pricing.ts`'s B585 prefactor #2) so no call site and no spec changes.
 *
 * `deleteOrder` is deliberately NOT here despite living in the same source region: it is the one
 * method with a direct `orderItem`/`invoiceItem` write, and `unit-line-writers.ast.spec.ts`'s AST
 * scanner only walks class methods (`ts.isClassDeclaration`) — a top-level function in this file
 * is invisible to it. Moving it would have silently dropped it from that guard's coverage.
 */

import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { FulfillPath, OrderStatus, RouteRunStatus, UserRole } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { staffMay } from "../auth/permissions/staff-capabilities";
import type { OrdersService } from "./orders.service";
import { UpdateFulfillPathDto } from "./dto/update-fulfill-path.dto";
import { UpdateShipmentDto } from "./dto/update-shipment.dto";
import { SHIPPED_STATUSES, notifyTrackingAdded } from "./shipment-notifications";

export async function updateShipmentImpl(
  self: OrdersService,
  orderId: string,
  dto: UpdateShipmentDto,
  _user?: JwtPayload,
) {
  const order = await self.prisma.forTenant().order.findFirst({
    where: { id: orderId },
    select: {
      id: true,
      shippedAt: true,
      status: true,
      fulfillPath: true,
      customerId: true,
      orderNumber: true,
      shippingTrackingNumber: true,
    },
  });
  if (!order) throw new NotFoundException("Order not found");

  const carrier = dto.shippingCarrier?.trim() || null;
  const tracking = dto.shippingTrackingNumber?.trim() || null;
  // E-b: shippedAt is the SHIP TRANSITION's stamp (changeStatus), never a side effect of saving
  // tracking on an order that has not shipped. Saving tracking keeps whatever is there; it only
  // backfills a legacy already-shipped order that has none.
  const shippedAt =
    order.shippedAt ?? (tracking && SHIPPED_STATUSES.has(order.status) ? new Date() : null);

  const updated = await self.prisma.forTenant().order.update({
    where: { id: orderId },
    data: { shippingCarrier: carrier, shippingTrackingNumber: tracking, shippedAt },
  });

  // Mirror onto every non-void invoice generated from this order.
  await self.prisma.forTenant().invoice.updateMany({
    where: { orderId, status: { not: "VOID" } },
    data: { shippingCarrier: carrier, shippingTrackingNumber: tracking, shippedAt },
  });

  // Tracking added for the FIRST time (empty -> set) to a carrier order that is ALREADY shipped: tell the
  // customer once. The atomic `trackingNotifiedAt` claim inside notifyTrackingAdded makes it never repeat.
  if (
    tracking &&
    !order.shippingTrackingNumber?.trim() &&
    order.fulfillPath === FulfillPath.SHIP &&
    SHIPPED_STATUSES.has(order.status)
  ) {
    void notifyTrackingAdded(
      self,
      {
        id: order.id,
        customerId: order.customerId,
        orderNumber: order.orderNumber,
        shippingCarrier: carrier,
        shippingTrackingNumber: tracking,
      },
      _user?.sub || null,
    );
  }

  return updated;
}

/**
 * Ad-hoc trips + fulfillment mode: change an order's fulfillment path
 * (ROUTE ↔ SHIP ↔ PICKUP) while it's still open. Locked once the order has left the
 * "open" states — a shipped/delivered/cancelled order's fulfillment history
 * shouldn't move out from under its trip/shipment records after the fact —
 * and locked toward SHIP or PICKUP while the order sits on a live run.
 */
export async function updateFulfillPathImpl(
  self: OrdersService,
  orderId: string,
  dto: UpdateFulfillPathDto,
  user?: JwtPayload,
) {
  // POS mode (SA-763r R3): switching an order to PICKUP is a hand-over at the till, a staff capability.
  if (dto.fulfillPath === FulfillPath.PICKUP && !staffMay(user?.role, "USE_POS_MODE")) {
    throw new ForbiddenException({
      code: API_ERROR_CODES.POS_MODE_NOT_PERMITTED,
      message: "You don't have access to switch an order to pickup.",
    });
  }
  // `findFirst`, NOT `findUnique`: forTenant()'s findUnique can only POST-filter
  // on the returned row's `tenantId`, and an exclusive `select` that omits it
  // silently disables that check — which would leak another tenant's order
  // status and driver name through the 400 messages below. findFirst gets
  // `tenantId` injected into the `where`, so a foreign id simply 404s here.
  const order = await self.prisma.forTenant().order.findFirst({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      routeRunId: true,
      routeRunStopId: true,
      routeRunStop: {
        select: {
          routeRun: { select: { status: true, driver: { select: { contactName: true } } } },
        },
      },
    },
  });
  if (!order) throw new NotFoundException("Order not found");
  if (
    order.status === OrderStatus.OUT_FOR_DELIVERY ||
    order.status === OrderStatus.DELIVERED ||
    order.status === OrderStatus.CANCELLED
  ) {
    throw new BadRequestException("Fulfillment path can only be changed while the order is open");
  }
  // Status alone isn't enough: the dispatch sweep attaches orders to a run
  // while they're still CONFIRMED, so a freshly dispatched order would flip
  // to SHIP and render as "Shipped" while still standing as a stop on the
  // driver's live run. Stale attachments are harmless, so only ACTIVE runs
  // block, mirroring TripsService.checkEligibility's ON_ACTIVE_RUN predicate.
  // Since F11 a run going terminal RELEASES the orders of every stop that
  // recorded no work, so a stale attachment now only survives on a COMPLETED
  // stop — or on a row stranded before that deploy, until the D4 repair runs.
  const run = order.routeRunStop?.routeRun ?? null;
  const onActiveRun =
    order.routeRunStopId != null &&
    run != null &&
    (run.status === RouteRunStatus.SCHEDULED || run.status === RouteRunStatus.IN_PROGRESS);
  if (
    (dto.fulfillPath === FulfillPath.SHIP || dto.fulfillPath === FulfillPath.PICKUP) &&
    onActiveRun
  ) {
    throw new BadRequestException(
      `This order is out on an active delivery run${
        run?.driver?.contactName ? ` with ${run.driver.contactName}` : ""
      }. Remove it from the run before switching it to ${
        dto.fulfillPath === FulfillPath.PICKUP ? "pickup" : "shipping"
      }.`,
    );
  }
  // B692 class: a PICKUP order that stays linked to a finished (COMPLETED / CANCELLED) run's stop is
  // skipped by the later stock stamp, which excludes rows carrying a routeRunStopId, so a later quantity
  // cut would restock what was never stamped. An active run was refused above; so the link left here is
  // always a finished run's, and the switch lets go of it in the same write.
  const releaseRun =
    dto.fulfillPath === FulfillPath.PICKUP &&
    (order.routeRunId != null || order.routeRunStopId != null);
  return self.prisma.forTenant().order.update({
    where: { id: orderId },
    data: {
      fulfillPath: dto.fulfillPath,
      ...(releaseRun ? { routeRunId: null, routeRunStopId: null } : {}),
    },
  });
}

export async function toggleUrgentImpl(
  self: OrdersService,
  id: string,
  user: JwtPayload,
  urgent?: boolean,
) {
  const order = await self.findOneOrThrow(id);
  if (user.role === UserRole.CUSTOMER) {
    // REG-B131: `deletedAt: null` here — a removal deactivates the user but an access token
    // minted just before it stays valid for up to 15 minutes, so a removed customer's own
    // in-flight session must fall into the existing refusal below.
    const customer = await self.prisma
      .forTenant()
      .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
    if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
  }
  // If caller provides an explicit value, SET it; otherwise toggle (legacy web clients)
  const newValue = urgent !== undefined ? urgent : !order.urgent;
  return self.prisma.forTenant().order.update({ where: { id }, data: { urgent: newValue } });
}

/**
 * REG-B78: header fields a buyer's cart merge must carry onto the EXISTING
 * order — merge semantics, not create semantics: notes APPEND (never clobber),
 * urgent only ever SETS true (a non-urgent add never clears an urgent order),
 * requestedDeliveryDate sets when provided and never clears.
 */
export async function applyBuyerMergeHeaderImpl(
  self: OrdersService,
  orderId: string,
  header: { notes?: string; urgent?: boolean; requestedDeliveryDate?: string },
  user: JwtPayload,
): Promise<void> {
  const order = await self.prisma.forTenant().order.findFirst({ where: { id: orderId } });
  if (!order) throw new NotFoundException("Order not found");
  if (user.role === UserRole.CUSTOMER) {
    // REG-B131: `deletedAt: null` here — a removal deactivates the user but an access token
    // minted just before it stays valid for up to 15 minutes, so a removed customer's own
    // in-flight session must fall into the existing refusal below.
    const customer = await self.prisma
      .forTenant()
      .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
    if (!customer || order.customerId !== customer.id) throw new ForbiddenException();
  }
  const data: Record<string, unknown> = {};
  const notes = (header.notes ?? "").trim();
  if (notes) data.notes = order.notes ? `${order.notes}\n${notes}` : notes;
  if (header.urgent === true) data.urgent = true;
  if (header.requestedDeliveryDate) {
    // Mirrors create()'s exact parse (:2107-2109) so merge and create agree
    // on timezone handling.
    data.requestedDeliveryDate = new Date(header.requestedDeliveryDate);
  }
  if (Object.keys(data).length) {
    await self.prisma.forTenant().order.update({ where: { id: orderId }, data });
  }
}

/**
 * Sales agents & commissions: staff-set (or clear, via `null`) per-order
 * commission-rate override. `0` is a valid value ("exempt"). Update + engine
 * resync run in ONE transaction so a resolved-rate change is atomic with the
 * order write. Does NOT touch updateOrderItems / item money — the existing
 * rebuildSiblingDrafts hook already covers item-edit money changes.
 */
export async function setCommissionRateImpl(
  self: OrdersService,
  orderId: string,
  ratePct: number | null,
  user: JwtPayload,
) {
  if (user.role !== UserRole.OPERATOR && user.role !== UserRole.TENANT_ADMIN) {
    throw new ForbiddenException("Only staff can set a commission rate");
  }
  if (
    ratePct !== null &&
    (typeof ratePct !== "number" || Number.isNaN(ratePct) || ratePct < 0 || ratePct > 100)
  ) {
    throw new BadRequestException("commissionRatePct must be between 0 and 100, or null to clear");
  }
  await self.findOneOrThrow(orderId);
  return self.prisma.tenantTransaction(async (tx) => {
    const order = await tx.order.update({
      where: { id: orderId },
      data: { commissionRatePct: ratePct },
    });
    await self.commissionEngine.syncOrderInvoices(orderId, tx);
    return order;
  });
}

export async function bulkDeleteOrdersImpl(self: OrdersService, ids: string[], user?: JwtPayload) {
  const results = await Promise.allSettled(ids.map((id) => self.deleteOrder(id, user)));
  const deleted = results.filter((r) => r.status === "fulfilled").length;
  const errors = results
    .map((r, i) => (r.status === "rejected" ? `${ids[i]}: ${r.reason?.message}` : null))
    .filter(Boolean) as string[];
  return { deleted, errors };
}

export async function findOneOrThrowImpl(self: OrdersService, id: string) {
  const order = await self.prisma.forTenant().order.findUnique({ where: { id } });
  if (!order) throw new NotFoundException("Order not found");
  return order;
}
