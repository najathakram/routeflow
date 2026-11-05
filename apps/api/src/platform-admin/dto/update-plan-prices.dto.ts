import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNumber, IsOptional, Min, ValidateIf } from "class-validator";

/**
 * Edit the CURRENT (latest published) PlanVersion's catalog price for one plan
 * key. `annual` omitted auto-fills to monthly × 10 (two months free); `annual:
 * null` explicitly clears it back to that same derived fallback at read time.
 */
export class UpdatePlanPricesDto {
  @ApiProperty({ description: "New monthly price for this plan." })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monthly: number;

  @ApiPropertyOptional({
    description: "New annual price; omit or pass null for monthly × 10.",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  annual?: number | null;

  /**
   * SA-1100 §2: how many businesses the admin confirmed this edit re-prices (the `affected` of the price-impact
   * read). The server counts again from the same selection BEFORE any write and answers 409
   * PLAN_PRICE_IMPACT_CHANGED if the number moved. Required: the only client is the platform-admin plans page.
   */
  @ApiProperty({
    description: "The count of businesses the admin confirmed (price-impact affected).",
  })
  @IsInt()
  @Min(0)
  expectedAffected: number;
}
