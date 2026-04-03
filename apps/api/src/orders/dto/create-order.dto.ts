import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

class OrderItemDto {
  @IsString() productId: string;
  @IsInt() @Min(1) qty: number;
  @IsOptional() @IsInt() @Min(0) boxes?: number;
  @IsOptional() @IsInt() @Min(0) pieces?: number;
  /** One-time discount price override — operator-supplied, not stored in CustomerPrice */
  @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() itemNote?: string;
  @IsOptional() @IsString() substitution?: string;
}

export class CreateOrderDto {
  @IsOptional() @IsString() customerId?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
  @IsOptional() @IsDateString() requestedDeliveryDate?: string;
  @IsOptional() @IsString() routeRunId?: string;
  @IsOptional() @IsString() routeRunStopId?: string;
  @IsOptional() @IsBoolean() immediateDelivery?: boolean;
  /** Order-level discount applied to the total */
  @IsOptional() @IsNumber() @Min(0) discountAmount?: number;
}
