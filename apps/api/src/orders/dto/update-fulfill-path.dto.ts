import { IsIn } from "class-validator";
import { FulfillPath } from "@prisma/client";
import { WRITABLE_FULFILL_PATHS } from "../writable-fulfill-paths";

/**
 * Ad-hoc trips + fulfillment mode: PATCH /orders/:id/fulfill-path body. The
 * service rejects the change once the order is OUT_FOR_DELIVERY, DELIVERED, or
 * CANCELLED — the fulfillment path can only be set while the order is open.
 */
export class UpdateFulfillPathDto {
  @IsIn(WRITABLE_FULFILL_PATHS)
  fulfillPath!: FulfillPath;
}
