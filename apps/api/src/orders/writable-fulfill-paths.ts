import { FulfillPath } from "@prisma/client";

/**
 * The fulfil paths the CUSTOMER write DTOs and PATCH fulfill-path may carry. PICKUP exists in the DB enum
 * (SA-650) but a customer never has a PICKUP default, so those DTOs refuse it. The ORDER create DTO accepts
 * the whole enum and resolve-fulfil-path.ts refuses PICKUP where the business does not offer it (SA-655);
 * list filters (read) accept it too.
 */
export const WRITABLE_FULFILL_PATHS = [FulfillPath.ROUTE, FulfillPath.SHIP] as const;
