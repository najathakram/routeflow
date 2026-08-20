import { IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, Min } from "class-validator";
import { Transform, Type } from "class-transformer";
import { OrderStatus } from "@prisma/client";

export class ListOrdersDto {
  @IsOptional() @IsString() customerId?: string;
  /**
   * PR-B: only orders containing at least one line for this product. Answers
   * "which orders had this item?" — `OrderItem.productId` is indexed, so this
   * is a cheap `lineItems: { some: { productId } }`. Composes with every other
   * filter (customer, status, dates) rather than replacing them.
   */
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() urgent?: boolean;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number = 20;
  @IsOptional() @IsDateString() deliveryDateFrom?: string;
  @IsOptional() @IsDateString() deliveryDateTo?: string;
}
