import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { Type } from "class-transformer";
import { StripHtml } from "../../common/transforms/strip-html.transform";

/**
 * PR-C: DTOs for the DURABLE stock-count session. The pre-existing
 * `CommitStockCountDto` (client-generated sessionId, commit-in-one-shot) stays
 * exactly as it was — these add the paused/resumable server-side session on top
 * without changing that contract.
 */

export class StartStockCountDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @StripHtml()
  name?: string;

  /**
   * Set to open this session as an AMENDMENT of an already-committed one,
   * pre-filled from its lines. Corrections never rewrite history: the amendment
   * commits fresh adjustments and both sessions stay readable.
   */
  @IsOptional()
  @IsString()
  amendsSessionId?: string;
}

export class UpsertStockCountLineDto {
  @IsString()
  productId!: string;

  /**
   * The counted number in base units. Omit when sending `boxes`/`pieces` — the
   * server recomputes qty from the split, exactly like the order builders, so a
   * boxed product can never be counted as loose pieces by accident.
   */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(9_999_999.999) // countedQty is Decimal(10,3)
  countedQty?: number;

  @IsOptional() @IsInt() @Min(0) @Max(100_000) @Type(() => Number) boxes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) @Type(() => Number) pieces?: number;

  /**
   * When true the counted value is ADDED to the line's existing count (the
   * scan path: every scan is +1). When false/absent it REPLACES it (the review
   * screen's inline edit). Distinct from `mode`, which is about the COMMIT.
   */
  @IsOptional()
  @IsBoolean()
  increment?: boolean;

  /** REPLACE = "on-hand IS this" (default). ADD = "add this to on-hand". */
  @IsOptional()
  @IsIn(["REPLACE", "ADD"])
  mode?: "REPLACE" | "ADD";

  /**
   * Optional per-line cost correction (4dp). Setting it makes the commit ALSO
   * write the audited COST_BASIS movement for this product — it is not just a
   * count. Send `null` to clear a previously-entered override.
   */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(1_000_000)
  unitCostOverride?: number | null;
}

export class CommitStockCountSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @StripHtml()
  notes?: string;

  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}

export class ListStockCountSessionsDto {
  @IsOptional()
  @IsIn(["OPEN", "REVIEW", "COMMITTED", "DISCARDED"])
  status?: "OPEN" | "REVIEW" | "COMMITTED" | "DISCARDED";

  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional() @IsInt() @Min(1) @Max(100) @Type(() => Number) limit?: number = 20;
}
