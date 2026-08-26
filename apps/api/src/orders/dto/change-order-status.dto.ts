import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { OrderStatus } from "@prisma/client";

export class ChangeOrderStatusDto {
  @IsEnum(OrderStatus) status: OrderStatus;

  /**
   * Required by the service for any demotion (a one-step-back transition), which
   * now includes staff-only DELIVERED → CONFIRMED/PARTIALLY_DELIVERED (the
   * "Reopen Order" action) and PENDING → DRAFT — see `changeStatus`'s
   * requires-reason set. Optional for forward transitions.
   */
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
