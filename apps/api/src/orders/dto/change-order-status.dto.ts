import { IsArray, IsEnum, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { OrderStatus } from "@prisma/client";
import { RunDeliveryDto } from "../../routes/dto/complete-stop.dto";

export class ChangeOrderStatusDto {
  @IsEnum(OrderStatus) status: OrderStatus;

  /**
   * Required by the service for any demotion (a one-step-back transition), which
   * now includes staff-only DELIVERED → CONFIRMED/PARTIALLY_DELIVERED (the
   * "Reopen Order" action) and PENDING → DRAFT — see `changeStatus`'s
   * requires-reason set. Optional for forward transitions.
   */
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;

  /**
   * SA-151 (B692): per-line quantities for a manual PARTIALLY_DELIVERED — same shape as
   * `completeWithPayment`'s `deliveries[]` (routes/dto/complete-stop.dto.ts), fit-checked
   * against each line's own remaining. Required unless the order already carries delivery
   * evidence from an earlier write; unused for any other transition.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RunDeliveryDto)
  deliveries?: RunDeliveryDto[];
}
