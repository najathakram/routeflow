import { FulfillPath } from "@prisma/client";

/**
 * The fulfil paths a CUSTOMER-facing write DTO may carry (a customer's own default path). PICKUP exists in
 * the DB enum (SA-650) but a customer never has a PICKUP default, so it is refused there; list filters
 * (read) accept it, and the ORDER create DTO accepts the whole enum (the one resolver is the refusal).
 */
export const WRITABLE_FULFILL_PATHS = [FulfillPath.ROUTE, FulfillPath.SHIP] as const;

/**
 * The paths STAFF may switch an ORDER to (`PATCH /orders/:id/fulfill-path`, SA-763r R3). PICKUP is POS mode
 * (a hand-over at the till): the service additionally needs `staffMay(role, "USE_POS_MODE")` and refuses
 * it on an active run. Used by the order switch DTO ONLY; the customer DTOs keep WRITABLE_FULFILL_PATHS.
 */
export const STAFF_ORDER_FULFILL_PATHS = [
  FulfillPath.ROUTE,
  FulfillPath.SHIP,
  FulfillPath.PICKUP,
] as const;
