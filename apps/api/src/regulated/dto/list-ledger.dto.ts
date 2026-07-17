import { Transform } from "class-transformer";
import { IsBoolean, IsOptional, IsString } from "class-validator";

export class ListLedgerDto {
  /** Filter to one tracked category id. */
  @IsOptional() @IsString() category?: string;
  /** ISO date — sales on/after this. */
  @IsOptional() @IsString() from?: string;
  /** ISO date — sales on/before this. */
  @IsOptional() @IsString() to?: string;
  /**
   * RF-3: also break the aggregation down by tracked SUBCATEGORY (reporting only).
   * Off by default — the response is byte-identical to the section-only aggregation
   * unless this is set. Query param arrives as the string "true".
   */
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() bySubcategory?: boolean;
}
