import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
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

/** The most ids one `GET /products?ids=` reads (same cap as the portal-visibility ids). A caller with more sends several requests. */
export const PRODUCT_IDS_QUERY_MAX = 200;

export class ListProductsDto {
  /**
   * P-21 (573): read exactly these products, comma-separated. 1..200 unique UUIDs; it ignores `page`, applies no
   * default `isActive` (a deactivated product on an old PO must still show its name) and, like every list read,
   * only ever sees the caller's tenant: an id from another tenant is simply absent.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string"
      ? [
          ...new Set(
            value
              .split(",")
              .map((v) => v.trim())
              .filter((v) => v !== ""),
          ),
        ]
      : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PRODUCT_IDS_QUERY_MAX)
  @IsUUID("all", { each: true })
  ids?: string[];

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
  /** Staff "Hidden from portal" filter: false = hidden only, true = visible only, absent = all. */
  @IsOptional()
  @Transform(({ value }) =>
    value === "true" || value === true
      ? true
      : value === "false" || value === false
        ? false
        : value,
  )
  @IsBoolean()
  portalVisible?: boolean;

  /** Regulated-section filter: "any" (any regulated), "none" (non-regulated), or a section id. */
  @IsOptional()
  @IsString()
  @Matches(
    /^(any|none|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
    { message: 'section must be "any", "none", or a section id' },
  )
  section?: string;
}
