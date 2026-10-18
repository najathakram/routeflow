import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { OrderStatus } from "@prisma/client";

/** B692: what was delivered on one line, for a manual PARTIALLY_DELIVERED (fit-checked against the line's qty). */
export class OfficeDeliveryLineDto {
  @IsString() orderItemId: string;
  @IsNumber() @Min(0) quantityDelivered: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

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
   * B692 (SA-814 R4-3): per-line quantities for a manual PARTIALLY_DELIVERED, written as delivery evidence in the
   * status transaction. Required unless the order already carries delivery data (a line with deliveredQty > 0, or
   * an evidence row): otherwise 409 ORDER_PD_NEEDS_QUANTITIES. Also accepted on PARTIALLY_DELIVERED -> OUT_FOR_DELIVERY for a legacy row with no quantities.
   * Unused for any other transition.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OfficeDeliveryLineDto)
  deliveries?: OfficeDeliveryLineDto[];
}
