import {
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class PriceAdjustmentItemDto {
  @IsUUID() itemId: string;
  @IsNumber() @Min(0) newUnitPrice: number;
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
