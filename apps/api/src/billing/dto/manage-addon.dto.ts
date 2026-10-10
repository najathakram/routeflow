import { IsString, IsOptional, IsBoolean, MinLength, MaxLength, Matches } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class EnableAddonDto {
  @ApiProperty({
    description: "Unique key for the add-on feature (e.g. ai_scanning, advanced_routes)",
    example: "ai_scanning",
  })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: "addonKey must be lowercase with underscores (e.g. ai_scanning)",
  })
  addonKey: string;

  @ApiPropertyOptional({
    description: "Stripe price ID for billing this add-on (optional, only if Stripe is configured)",
    example: "price_1234567890",
  })
  @IsOptional()
  @IsString()
  stripePriceId?: string;

  @ApiPropertyOptional({
    description:
      "B524: explicit acknowledgment that this addon's registry `requires` prerequisite is " +
      "unmet for this tenant — required to proceed when it is, ignored otherwise. Defaults to " +
      "false (enforce) when omitted; mirrors the console's own checkbox (PR #899).",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeUnmetRequires?: boolean;

  @ApiPropertyOptional({
    description:
      "SA-693: grant this add-on as a COMP — free on purpose: no Stripe item even on a subscribed " +
      "tenant (a stripePriceId is ignored), price 0, never billed, never blocks a checkout. An " +
      "EXPLICIT choice: omitted/false means a normal enable (billed when a price is given). " +
      "Audited as ADDON_COMPED.",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  comp?: boolean;

  @ApiPropertyOptional({
    description: "Why (audit trail only; written to the ADDON_COMPED row). Max 500 characters.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UncompAddonDto {
  @ApiProperty({
    description: "Key of the comp add-on to make billable",
    example: "tobacco_dealer",
  })
  @IsString()
  addonKey: string;

  @ApiPropertyOptional({
    description:
      "Required when the tenant has a Stripe subscription: the catalog Stripe price the add-on is " +
      "billed at (uncomping goes through the normal billed enable). Ignored otherwise.",
  })
  @IsOptional()
  @IsString()
  stripePriceId?: string;

  @ApiPropertyOptional({ description: "Why (audit trail only). Max 500 characters." })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DisableAddonDto {
  @ApiProperty({
    description: "Key of the add-on to disable",
    example: "ai_scanning",
  })
  @IsString()
  addonKey: string;
}
