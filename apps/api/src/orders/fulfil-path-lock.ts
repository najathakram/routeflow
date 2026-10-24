import { OrderStatus } from "@prisma/client";

/**
 * Row 673 (SA-831b M6): the ONE status lock on an order's fulfil path. `PATCH /orders/:id/fulfill-path` refuses on it, and
 * `GET /orders/:id` carries it as `fulfillPathLocked`, so a client reads the server's answer instead of re-deriving it
 * from the status (mobile POS offered "Switch to delivery" on a Ready-for-pickup order and it always failed). A shipped,
 * delivered or cancelled order's fulfilment history must not move under its trip / shipment records.
 *
 * Status lock only: `false` does NOT promise the PATCH succeeds. The account's offered paths, the active-run lock, the
 * address check and the selling-restrictions re-judge still apply after it (order-lifecycle.ts).
 *
 * `fromOutForDelivery` is SA-913 (c)'s one caller-pinned exception ("Complete at counter", an order just taken off its
 * run); the order read never passes it, so the read reports what the PATCH would answer.
 */
export function fulfillPathLocked(
  order: { status: string },
  opts?: { fromOutForDelivery?: boolean; linked?: boolean },
): boolean {
  if (order.status === OrderStatus.OUT_FOR_DELIVERY)
    return !(opts?.fromOutForDelivery && !opts.linked);
  return order.status === OrderStatus.DELIVERED || order.status === OrderStatus.CANCELLED;
}
