import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import { Type } from "class-transformer";

/** Max products per page on the Customer view. */
export const CUSTOMER_UNIT_PRICES_MAX_LIMIT = 100;

export class CustomerUnitPricesQueryDto {
  /** Narrow to one product (the product-page Customer view). */
  @IsOptional() @IsString() @IsUUID() productId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CUSTOMER_UNIT_PRICES_MAX_LIMIT)
  limit?: number;
}
