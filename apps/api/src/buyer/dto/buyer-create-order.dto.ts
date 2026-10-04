import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { FulfillPath } from "@prisma/client";

// BUG-B1-6: same numeric/length caps as CreateOrderDto so the buyer-facing
// order endpoint cannot accept 999,999 cases of bread or 5MB of notes.
class BuyerOrderItemDto {
  @IsString() @MaxLength(64) productId: string;
  @IsInt() @Min(1) @Max(100_000) qty: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) boxes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) pieces?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class BuyerCreateOrderDto {
  @IsArray()
  @ArrayMinSize(1, { message: "Order must contain at least one item" })
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BuyerOrderItemDto)
  items: BuyerOrderItemDto[];

  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
  @IsOptional() @IsDateString() requestedDeliveryDate?: string;
  @IsOptional() @IsEnum(["PENDING"]) status?: "PENDING";
  @IsOptional() @IsBoolean() forceNew?: boolean;
  /**
   * Business profiles 1B: how the buyer wants this order fulfilled. Omit it to take the seller's
   * portal default. The controller refuses a path the seller's portal doesn't offer (400
   * FULFILMENT_PATH_NOT_OFFERED); PICKUP is not a FulfillPath value, so it never validates.
   */
  @IsOptional() @IsEnum(FulfillPath) fulfillPath?: FulfillPath;
}
