import { IsIn, IsOptional, IsDateString, IsString, MinLength, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

// Two literal values — not worth a shared packages/types constant, and a VALUE import from
// @routeflow/types would crash the API's production boot (L-151: nest build doesn't bundle
// workspace deps, so a value import — not `import type` — emits an unparseable require() into
// dist/). See feature-registry.ts's isRegisteredFeatureKey for the real gatekeeping check;
// this only constrains the two literals the column itself accepts.
const FEATURE_OVERRIDE_EFFECTS = ["GRANT", "DENY"] as const;

export class CreateFeatureOverrideDto {
  @ApiProperty({
    description: "Feature registry key this override applies to (validated against the registry)",
    example: "tobacco_dealer",
  })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  featureKey: string;

  @ApiProperty({ enum: FEATURE_OVERRIDE_EFFECTS, example: "GRANT" })
  @IsIn(FEATURE_OVERRIDE_EFFECTS)
  effect: (typeof FEATURE_OVERRIDE_EFFECTS)[number];

  @ApiProperty({
    description: "Why this override exists — shown in the tenant's override history",
    example: "Pilot: waived while onboarding, remove after 30 days",
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({
    description: "ISO date the override stops applying; omit/null for a standing override",
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
