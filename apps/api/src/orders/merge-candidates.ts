/**
 * ONE merge predicate for every order-merge entry point (L-167): two orders only ever fold into each
 * other when they share the same EFFECTIVE fulfil path. A carrier (SHIP) order must never be folded
 * into a delivery (ROUTE) order, or the parcel disappears from the shipping flow (or a route stop grows
 * a carrier line).
 *
 *  - `findActiveOrder` (staff create auto-merge, the buyer's active-order fold, the backdated-order check)
 *    narrows its candidate search with `mergeCandidateWhere`;
 *  - `mergeAllPendingForCustomer` (also the post-commit sweeps, the standing-order templates and the
 *    hourly sweep) and `forceConsolidateCustomer` keep only the winner's path via `sameFulfilPathAsWinner`.
 *
 * No new lock: the callers' `withAdvisoryLock("order-merge")` stays the only one.
 */
import { FulfillPath, ItemStatus, OrderStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/** An order's path; a row with none (never the case in production: the column is NOT NULL) is ROUTE. */
export function effectiveFulfilPath(o: { fulfillPath?: FulfillPath | null }): FulfillPath {
  return o.fulfillPath ?? FulfillPath.ROUTE;
}

/**
 * An order that has already SHIPPED (`shippedAt` is stamped only by the ship transition and survives an
 * unmark and a reopen) is never a merge candidate, winner or loser: a fold deletes the losers, which would
 * destroy a shipped order and its `shippedAt` (and walk around the carrier-order cancel/delete guard).
 */
export function unshipped<T extends { shippedAt?: Date | null }>(orders: T[]): T[] {
  return orders.filter((o) => !o.shippedAt);
}

/** The orders that may fold together: those on the SAME path as the winner (the first, most recent). */
export function sameFulfilPathAsWinner<T extends { fulfillPath?: FulfillPath | null }>(
  orders: T[],
): T[] {
  if (orders.length <= 1) return orders;
  const winnerPath = effectiveFulfilPath(orders[0]);
  return orders.filter((o) => effectiveFulfilPath(o) === winnerPath);
}

/** The `where` fragment that limits a merge-target search to the incoming order's path. */
export function mergeCandidateWhere(fulfillPath?: FulfillPath): { fulfillPath?: FulfillPath } {
  return fulfillPath ? { fulfillPath } : {};
}

/**
 * The path an incoming order will carry: the one it asks for, else the customer's stored default
 * (ROUTE when there is none). This is the pre-merge candidate search's input; the order-create resolver
 * must agree with it (a single place to change when the resolution rules change).
 */
export async function incomingFulfilPath(
  prisma: Pick<PrismaService, "forTenant">,
  customerId: string,
  explicit?: FulfillPath | null,
): Promise<FulfillPath> {
  if (explicit) return explicit;
  const customer = await prisma
    .forTenant()
    .customer.findFirst({ where: { id: customerId }, select: { fulfillPath: true } });
  return effectiveFulfilPath(customer ?? {});
}

export interface MergeSearchOpts {
  /** A merge-target search: exclude orders a merge must not touch (unit-aware lines). */
  forMerge?: boolean;
  /** The incoming order's path: `explicit` when it asked for one, else the customer's stored path. */
  mergeAs?: { explicit?: FulfillPath | null };
}

/**
 * Find the most recent active (DRAFT/PENDING) order for a customer (the buyer portal merges new items
 * into it; staff create offers it as a merge target). `mergeAs` limits the search to orders on the
 * incoming order's path (see the module doc).
 */
export async function findActiveOrderImpl(
  prisma: Pick<PrismaService, "forTenant">,
  customerId: string,
  opts: MergeSearchOpts = {},
  /** units_v1: the caller's guard fragment (a unit-aware order is never a merge target). */
  mergeGuard: object = {},
) {
  // `mergeAs`: the caller is about to fold an incoming order in; resolve ITS path (explicit, else the
  // customer's stored one) and only consider orders on the same path.
  const fulfillPath = opts.mergeAs
    ? await incomingFulfilPath(prisma, customerId, opts.mergeAs.explicit)
    : undefined;
  // Orders flagged skipAutoMerge are intentionally kept separate by an operator —
  // do NOT propose them as a merge target. The next operator-initiated create for
  // the same customer should still see no "active" order to merge into.
  return prisma.forTenant().order.findFirst({
    where: {
      customerId,
      status: { in: [OrderStatus.DRAFT, OrderStatus.PENDING] },
      skipAutoMerge: false,
      // units_v1: a unit-aware order is never a MERGE target; display reads keep it visible.
      ...mergeGuard,
      shippedAt: null, // an already-shipped order is never a merge target (see `unshipped`)
      ...mergeCandidateWhere(fulfillPath),
    },
    include: {
      lineItems: {
        where: { status: { not: ItemStatus.CANCELLED } },
        include: { product: { select: { id: true, name: true, unit: true } } },
      },
      customer: { select: { id: true, businessName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}
