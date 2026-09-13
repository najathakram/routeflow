import { RouteKind } from "@prisma/client";

/**
 * REG-B156/REG-B157: what counts as "this customer currently has a live route
 * assignment". Shared by routes.service.ts's getCustomerRouteAssignments (the
 * "Currently in: <route>" hint) and customers.service.ts's `unassigned=1`
 * filter, so the hint and the filter can never disagree about the same
 * customer on the same screen (an ADHOC trip is a one-shot stop, not a
 * recurring assignment, so only a SCHEDULED route counts).
 */
export const SCHEDULED_ROUTE_KIND_WHERE = { kind: RouteKind.SCHEDULED } as const;

/**
 * REG-B131/REG-B157: a soft-deleted (removed) customer's route stop is
 * excluded from every planning/dispatch read. A stop with no customer
 * (customerId null — a manual/depot stop) is not a customer stop and always
 * stays. One shared shape so every reader agrees; stateless — restoring the
 * customer makes the next read include it again.
 */
export const LIVE_CUSTOMER_STOP_WHERE = {
  OR: [{ customerId: null }, { customer: { deletedAt: null } }],
} as const;
