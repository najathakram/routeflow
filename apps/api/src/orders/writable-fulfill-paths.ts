import { FulfillPath } from "@prisma/client";

/**
 * The fulfil paths a WRITE DTO may carry. PICKUP exists in the DB enum (SA-650) but is refused on
 * every write DTO until the counter-sale API (feat/counter-sale-api) lands; list filters (read) accept it.
 */
export const WRITABLE_FULFILL_PATHS = [FulfillPath.ROUTE, FulfillPath.SHIP] as const;
