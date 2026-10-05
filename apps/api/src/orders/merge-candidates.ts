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
import { BadRequestException } from "@nestjs/common";
import { FulfillPath, ItemStatus, OrderStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { resolveFulfilPath, type FulfilPathDeps } from "./fulfil-path-resolver";

/** An order's path; a row with none (never the case in production: the column is NOT NULL) is ROUTE. */
export function effectiveFulfilPath(o: { fulfillPath?: FulfillPath | null }): FulfillPath {
  return o.fulfillPath ?? FulfillPath.ROUTE;
}

/**
 * The orders that fold together in one pass: the first path (most recent first) that has MORE THAN ONE
 * order, so [SHIP newest, ROUTE, ROUTE] still merges the ROUTE pair and never touches the SHIP order;
 * with no path holding two, just the winner (the most recent), which is a no-op fold. Orders on other
 * paths are left exactly as they are (the next sweep takes the next pair).
 */
export function sameFulfilPathAsWinner<T extends { fulfillPath?: FulfillPath | null }>(
  orders: T[],
): T[] {
  if (orders.length <= 1) return orders;
  const byPath = new Map<FulfillPath, T[]>();
  for (const o of orders) {
    const path = effectiveFulfilPath(o);
    byPath.set(path, [...(byPath.get(path) ?? []), o]);
  }
  return [...byPath.values()].find((g) => g.length > 1) ?? [orders[0]];
}

/** The `where` fragment that limits a merge-target search to the incoming order's path. */
export function mergeCandidateWhere(fulfillPath?: FulfillPath): { fulfillPath?: FulfillPath } {
  return fulfillPath ? { fulfillPath } : {};
}

/**
 * The path an incoming order will carry, resolved EXACTLY as order create resolves it (the caller passes
 * the shared resolver, `fulfil-path-resolver.ts`): the pre-merge candidate search and the create can
 * never disagree about which path an order is on.
 */
export type ResolveIncomingPath = (
  explicit: FulfillPath | null | undefined,
  stored: FulfillPath | null | undefined,
) => Promise<FulfillPath>;

async function incomingFulfilPath(
  prisma: Pick<PrismaService, "forTenant">,
  customerId: string,
  explicit: FulfillPath | null | undefined,
  resolve: ResolveIncomingPath,
): Promise<FulfillPath> {
  const customer = await prisma
    .forTenant()
    .customer.findFirst({ where: { id: customerId }, select: { fulfillPath: true } });
  return resolve(explicit, customer?.fulfillPath);
}

export interface MergeSearchOpts {
  /** A merge-target search: exclude orders a merge must not touch (unit-aware lines). */
  forMerge?: boolean;
  /** The incoming order's path: `explicit` when it asked for one, else the customer's stored path. */
  mergeAs?: { explicit?: FulfillPath | null; audience?: "staff" | "buyer" };
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
  /** The shared resolver's inputs (`fulfil-path-resolver.ts`): the incoming path resolves EXACTLY as create's. */
  fulfilDeps: FulfilPathDeps = { tenantId: null },
) {
  const resolve: ResolveIncomingPath = (explicit, stored) =>
    resolveFulfilPath(fulfilDeps, {
      explicit,
      stored,
      audience: opts.mergeAs?.audience ?? "staff",
    });
  // `mergeAs`: the caller is about to fold an incoming order in; resolve ITS path (explicit, else the
  // customer's stored one) and only consider orders on the same path.
  const fulfillPath = opts.mergeAs
    ? await incomingFulfilPath(prisma, customerId, opts.mergeAs.explicit, resolve)
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

/**
 * A backdated order is refused while an open order it would MERGE into exists (an auto-merge folds into the
 * existing order, whose own business date stays authoritative). "Would merge into" = same fulfil path, the
 * same `mergeAs` rule the create's own merge search uses.
 */
export async function assertNoBackdatedMerge(
  orders: { findActiveOrder(customerId: string, opts: MergeSearchOpts): Promise<unknown> },
  customerId: string,
  explicit?: FulfillPath | null,
): Promise<void> {
  if (await orders.findActiveOrder(customerId, { forMerge: true, mergeAs: { explicit } })) {
    throw new BadRequestException(
      "This customer has an open order. Enter a backdated order as a separate order.",
    );
  }
}
