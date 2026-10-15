import { IsIn } from "class-validator";
import { FulfillPath } from "@prisma/client";
import { STAFF_ORDER_FULFILL_PATHS } from "../writable-fulfill-paths";

/**
 * Ad-hoc trips + fulfillment mode: PATCH /orders/:id/fulfill-path body. The
 * service rejects the change once the order is OUT_FOR_DELIVERY, DELIVERED, or
 * CANCELLED — the fulfillment path can only be set while the order is open.
 * PICKUP (POS mode) is staff-only and needs the USE_POS_MODE capability (checked in the service).
 */
export class UpdateFulfillPathDto {
  @IsIn(STAFF_ORDER_FULFILL_PATHS)
  fulfillPath!: FulfillPath;
}
