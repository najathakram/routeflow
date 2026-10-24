import { UserRole } from "@prisma/client";
import { cashierNameOf } from "@routeflow/pricing";

/**
 * Row 342: "Handed over at register main by Pat" on the staff order / invoice detail. The stamp is the order's
 * `registerKey` (a scalar, always on the row) and its `soldBy` cashier. The cashier is read as the SAME minimal
 * select Today's sales uses (row 317): the username only, never the email or any other user column; the display
 * rule is pricing's `cashierNameOf` (applied by the reader that renders it).
 *
 * STAFF ONLY: a buyer and a driver never get the cashier relation (the buyer projections are allowlists that name
 * neither field; this keeps the relation out of the READ too, so no cashier name rides a buyer-reachable read).
 */
export const HANDOVER_SOLD_BY_SELECT = { select: { username: true } } as const;

const STAMP_ROLES: readonly string[] = [
  UserRole.OPERATOR,
  UserRole.TENANT_ADMIN,
  UserRole.SUPER_ADMIN,
];

/** Whether a caller may be shown who handed an order over (no caller, a buyer or a driver may not). */
export function seesHandOverStamp(user: { role?: string } | null | undefined): boolean {
  return !!user?.role && STAMP_ROLES.includes(user.role);
}

/**
 * The display name of who handed the order over, built ONCE here (never re-derived by a client): the order's
 * `soldBy` username through pricing's `cashierNameOf` (trimmed; an email-like or missing username is null).
 * Added IN PLACE as `handedOverBy` on a staff read of an order (or an invoice's `order` stub); a caller who may
 * not see the stamp gets the row untouched. Returns the same row.
 */
export function stampHandedOverBy<
  T extends { soldBy?: { username?: string | null } | null } | null,
>(order: T, user: { role?: string } | null | undefined): T {
  if (order && seesHandOverStamp(user)) {
    Object.assign(order, { handedOverBy: cashierNameOf(order.soldBy) });
  }
  return order;
}
