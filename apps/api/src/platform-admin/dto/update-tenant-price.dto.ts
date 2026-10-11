import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNumber, IsOptional, Max, Min, ValidateIf } from "class-validator";
import {
  PRICE_OVERRIDE_EFFECTIVE,
  type PriceOverrideEffective,
} from "../../billing/price-override";

/**
 * Set or clear a tenant's custom price override (Platform billing — catalog-driven
 * Stripe prices). `null` clears the field back to the catalog; omitting a field
 * leaves it untouched. `annual: null` means "derive from monthly × 10" rather than
 * a literal price.
 */
export class UpdateTenantPriceDto {
  @ApiPropertyOptional({
    description: "Custom monthly fee; null clears the override (falls back to the catalog).",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100000)
  monthly?: number | null;

  @ApiPropertyOptional({
    description:
      "Custom annual fee; null clears the override (falls back to monthly × 10, or the catalog's annual price).",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100000)
  annual?: number | null;

  @ApiPropertyOptional({
    enum: PRICE_OVERRIDE_EFFECTIVE,
    default: "next_cycle",
    description:
      "When a live Stripe subscription takes the new price: `next_cycle` (default) = proration_behavior none; " +
      "`now_prorated` = create_prorations (the adjustment lands on the next invoice).",
  })
  @IsOptional()
  @IsIn(PRICE_OVERRIDE_EFFECTIVE)
  effective?: PriceOverrideEffective;
}
