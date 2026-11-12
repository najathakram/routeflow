import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { MAX_UNIT_PRICE } from "@routeflow/pricing";
import { CREATE_ORDER_MAX_ITEMS } from "./create-order-limits";

/** SA-1124: one line of what the device showed offline. Money has at most 2 decimals; the server never prices from it. */
export class OfflineQuoteLineDto {
  @IsInt() @Min(0) @Max(CREATE_ORDER_MAX_ITEMS) index: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_UNIT_PRICE) unitPrice: number;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) unitsPerBox?: number | null;
  @IsOptional() @IsString() @MaxLength(64) unitLabel?: string | null;
}

export class OfflineQuoteDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000_000) total: number;
  @IsArray()
  @ArrayMaxSize(CREATE_ORDER_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => OfflineQuoteLineDto)
  lines: OfflineQuoteLineDto[];
}
