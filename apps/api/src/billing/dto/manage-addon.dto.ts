import { IsString, IsOptional, MinLength, MaxLength, Matches } from "class-validator";
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
}

export class DisableAddonDto {
  @ApiProperty({
    description: "Key of the add-on to disable",
    example: "ai_scanning",
  })
  @IsString()
  addonKey: string;
}
