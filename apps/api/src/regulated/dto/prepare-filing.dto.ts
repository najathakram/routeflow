import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";

export class PrepareFilingDto {
  @IsString()
  @IsNotEmpty()
  trackedCategoryId!: string;

  // Defaults to the category's own reportCadence when omitted.
  @IsOptional()
  @IsIn(["MONTHLY", "QUARTERLY", "ANNUAL"])
  cadence?: "MONTHLY" | "QUARTERLY" | "ANNUAL";

  @IsInt()
  @Min(2020)
  @Max(2100)
  year!: number;

  // Month 1-12 (MONTHLY) or quarter 1-4 (QUARTERLY); ignored for ANNUAL. The
  // cadence-specific range is enforced in the service once cadence is resolved.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  index?: number;
}
