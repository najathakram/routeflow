/**
 * OWNER RULING 2026-10-03 — a customer always gets their own tier / special price, whoever enters the
 * item; a DRIVER still cannot set a custom price or a discount.
 *
 * `updateOrderItems` used to resolve a NEW or SUBSTITUTED line's price through the customer's tier
 * only for staff (OPERATOR / TENANT_ADMIN) and billed every other caller at tier 1 (LIST). Drivers
 * now resolve exactly like staff; only the right to TYPE a price stays staff-only (B13, and
 * `classifyEditPayload` strips a driver's price fields from a diff payload before it gets here).
 *
 * Forward-only: an existing line keeps its STORED price on a driver qty edit — only lines created or
 * substituted from now on resolve the tier. Kept out of orders.service.ts (size ratchet).
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
export const typedLinePrice = (user: Caller, sent: number | string | null | undefined) =>
  isDriverCaller(user) || sent === undefined ? null : Number(sent);
