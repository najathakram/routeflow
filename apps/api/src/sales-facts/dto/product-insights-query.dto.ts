import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { INSIGHT_GRAINS, type InsightGrain } from "../../analytics/demand-range";

/**
 * #2118 query DTOs for `/analytics/products/:id/*`. An EMPTY value is accepted and treated as
 * absent (an absent and an empty query param are indistinguishable to most clients), matching
 * `/analytics/demand`'s `range`. Day values are validated for real dates by the service
 * (`resolveInsightRange`), which answers 400 for an impossible day or an over-long window.
 */
const DAY_OR_EMPTY = /^(\d{4}-\d{2}-\d{2})?$/;
const DAY_MESSAGE = "must be a calendar day (YYYY-MM-DD)";

export class ProductInsightsQueryDto {
  @IsOptional()
  @IsString()
  @Matches(DAY_OR_EMPTY, { message: `from ${DAY_MESSAGE}` })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DAY_OR_EMPTY, { message: `to ${DAY_MESSAGE}` })
  to?: string;

  @IsOptional()
  @IsIn(["", ...INSIGHT_GRAINS])
  grain?: InsightGrain | "";

  /** "all" returns every buyer (export); default is the top 50. */
  @IsOptional()
  @IsIn(["", "all"])
  buyers?: "all" | "";
}

export class ProductSalesQueryDto {
  @IsOptional()
  @IsString()
  @Matches(DAY_OR_EMPTY, { message: `from ${DAY_MESSAGE}` })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DAY_OR_EMPTY, { message: `to ${DAY_MESSAGE}` })
  to?: string;

  /** Only this buyer's lines. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  customerId?: string;

  /** Opaque — the previous page's `nextCursor`. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  /** Lines per page (1-500, default 100). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class ProductInsightsCsvQueryDto {
  @IsOptional()
  @IsString()
  @Matches(DAY_OR_EMPTY, { message: `from ${DAY_MESSAGE}` })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DAY_OR_EMPTY, { message: `to ${DAY_MESSAGE}` })
  to?: string;

  /** Only this buyer's lines (the window totals footer is then omitted). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  customerId?: string;
}
