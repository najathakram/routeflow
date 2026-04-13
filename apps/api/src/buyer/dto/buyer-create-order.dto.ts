import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

class BuyerOrderItemDto {
  @IsString() productId: string;
  @IsInt() @Min(1) qty: number;
  @IsOptional() @IsInt() @Min(0) boxes?: number;
  @IsOptional() @IsInt() @Min(0) pieces?: number;
  @IsOptional() @IsString() notes?: string;
}

export class BuyerCreateOrderDto {
  @IsArray()
  @ArrayMinSize(1, { message: "Order must contain at least one item" })
  @ValidateNested({ each: true })
  @Type(() => BuyerOrderItemDto)
  items: BuyerOrderItemDto[];

  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
  @IsOptional() @IsDateString() requestedDeliveryDate?: string;
  @IsOptional() @IsEnum(["PENDING"]) status?: "PENDING";
  @IsOptional() @IsBoolean() forceNew?: boolean;
}
