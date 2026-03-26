import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

class OrderItemDto {
  @IsString() productId: string;
  @IsInt() @Min(1) qty: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() itemNote?: string;
  @IsOptional() @IsString() substitution?: string;
}

export class CreateOrderDto {
  @IsOptional() @IsString() customerId?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => OrderItemDto) items: OrderItemDto[];
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
  @IsOptional() @IsDateString() requestedDeliveryDate?: string;
}
