import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { Type, Transform } from "class-transformer";

export enum StockStatusFilter {
  IN_STOCK = "IN_STOCK",
  LOW = "LOW",
  OUT_OF_STOCK = "OUT_OF_STOCK",
}

export class ListProductsDto {
  @IsOptional() @IsString() search?: string;
  /** Scanned code for the resolve ladder's fallback rung: expanded server-side
   *  via normalizeScanCode so the contains-search is decoder-independent
   *  (iOS 13-digit vs desktop 12-digit decodes of the same label). Ignored
   *  when `search` is also present. */
  @IsOptional() @IsString() @MaxLength(64) scanCode?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() isActive?: boolean;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() isTobacco?: boolean;
  @IsOptional() @IsEnum(StockStatusFilter) stockStatus?: StockStatusFilter;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  // limit=0 is the "fetch-all" sentinel (service caps it at 10_000); web
  // product pickers rely on it and on larger page sizes (500/1000). The old
  // @Min(1)@Max(200) rejected all of those with 400, leaving pickers empty.
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000) limit?: number;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() includeVariants?: boolean;

  /** Regulated-section filter: "any" (any regulated), "none" (non-regulated), or a section id. */
  @IsOptional()
  @IsString()
  @Matches(
    /^(any|none|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
    { message: 'section must be "any", "none", or a section id' },
  )
  section?: string;
}
