/**
 * OWNER RULING 2026-10-03 (B1036) — a customer always gets their own tier / per-product special price,
 * whoever enters the item; a DRIVER still cannot set a custom price, discount or override reason.
 *
 * `updateOrderItems` priced a NEW or SUBSTITUTED line through the customer's tier (and, flag on, the
 * customer's typed unit price) only for staff (OPERATOR / TENANT_ADMIN) and the buyer, and billed a
 * DRIVER's line at tier 1 (LIST). A driver now resolves exactly like staff: the same tier / special
 * price / customer-typed price, with the same fail-closed 503 when the customer-prices read fails.
 * Only the right to TYPE a price stays staff-only (B13, and `classifyEditPayload` strips a driver's
 * price fields from a diff payload before it gets here).
 *
 * Forward-only: an existing line keeps its STORED price on a driver qty edit and on a driver full-list
 * replace; only lines created or substituted from now on resolve the tier. Kept out of
 * orders.service.ts (size ratchet).
 */
import { UserRole } from "@prisma/client";

type Caller = { role?: string } | null | undefined;

const isStaff = (user: Caller): boolean =>
  user?.role === UserRole.OPERATOR || user?.role === UserRole.TENANT_ADMIN;

/** True for the driver app / driver token. */
export const isDriverCaller = (user: Caller): boolean => user?.role === UserRole.DRIVER;

/** Whose edit-items lines resolve the CUSTOMER's tier / special price: staff and drivers. */
export const linesPriceAtCustomerTier = (user: Caller): boolean =>
  isStaff(user) || isDriverCaller(user);

/**
 * The price a client typed on a line, honoured for staff only. A driver's is dropped (null) here as
 * well as by `classifyEditPayload`, so no later edit to either can let a driver price a line.
 */
export const typedLinePrice = (
  user: Caller,
  sent: number | string | null | undefined,
): number | null => (isDriverCaller(user) || sent == null ? null : Number(sent));
