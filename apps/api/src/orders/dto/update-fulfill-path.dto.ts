import { IsEnum } from "class-validator";
import { FulfillPath } from "@prisma/client";

/**
 * Ad-hoc trips + fulfillment mode: PATCH /orders/:id/fulfill-path body. The
 * service rejects the change once the order is OUT_FOR_DELIVERY, DELIVERED, or
 * CANCELLED — the fulfillment path can only be set while the order is open.
 */
export class UpdateFulfillPathDto {
  @IsEnum(FulfillPath)
  fulfillPath!: FulfillPath;
}
