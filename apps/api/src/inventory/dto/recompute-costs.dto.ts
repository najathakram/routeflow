import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class RecomputeCostsDto {
  /** Limit the recompute to these products; omit for all products. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productIds?: string[];

  /**
   * B562 PR-3 (SA-136 §4): compute and report without writing anything. DEFAULTS TO TRUE — only an
   * explicit `dryRun: false` applies the corrections (one appended COST_BASIS row per product).
   */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /** Why the apply is being run; recorded on the apply's audit row. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
