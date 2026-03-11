import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class OrderItemDto {
  @IsString() productId: string;
  @IsInt() @Min(1) qty: number;
  @IsOptional() @IsString() notes?: string;
}

export class CreateOrderDto {
  @IsString() customerId: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OrderItemDto) items: OrderItemDto[];
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
}
