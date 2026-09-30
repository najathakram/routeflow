import { IsOptional, IsString, MaxLength } from "class-validator";

// Tenant-configurable display names for price tiers 1-5, e.g. "Wholesaler" instead of
// "Tier 2" (rung-2 config; render-time fallback lives in common/tier-label.ts). All
// fields optional; "" clears a field back to the default (see
// SystemConfigService.setPricingTierLabels PATCH semantics).
export class PricingTierLabelsDto {
  @IsOptional()
  @IsString()
  @MaxLength(24)
  tier1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  tier2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  tier3?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  tier4?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  tier5?: string;
}
