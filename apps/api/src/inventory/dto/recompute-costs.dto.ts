import { IsArray, IsBoolean, IsOptional, IsString } from "class-validator";

export class RecomputeCostsDto {
  /** Limit the recompute to these products; omit for all products. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productIds?: string[];

  /** Compute and report without writing anything. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
