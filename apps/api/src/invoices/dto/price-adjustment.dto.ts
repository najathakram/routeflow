import {
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { MAX_DECIMAL_10_2 } from "../../common/decimal-bounds.constant";
import { IsWholeCents } from "../../common/is-whole-cents.validator";

export class PriceAdjustmentItemDto {
  @IsUUID() itemId: string;
  /**
   * B1120: InvoiceItem.unitPrice is numeric(10,2) and every other writer stores whole cents, so a price
   * with a 3rd decimal (8.355) is refused here instead of being stored rounded while the line total was
   * computed from the raw value. The ceiling is the column's own (B2191), not a business cap.
   */
  @IsNumber() @Min(0) @Max(MAX_DECIMAL_10_2) @IsWholeCents() newUnitPrice: number;
}

export class PriceAdjustmentDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriceAdjustmentItemDto)
  items: PriceAdjustmentItemDto[];

  @IsIn(["SINGLE", "ALL_CUSTOMER_SINCE"])
  scope: "SINGLE" | "ALL_CUSTOMER_SINCE";

  /** Required when scope = ALL_CUSTOMER_SINCE. Invoices created on or after this date are affected. */
  @IsOptional()
  @IsDateString()
  sinceDate?: string;
}
