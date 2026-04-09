import { IsString, IsOptional, Matches, MaxLength } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class UpdateBrandingDto {
  @ApiPropertyOptional({ description: "Business display name" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  businessName?: string;

  @ApiPropertyOptional({ description: "Primary brand color as hex (e.g. #3B82F6)" })
  @IsOptional()
  @IsString()
  @Matches(/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/, {
    message: "primaryColor must be a valid hex color (e.g. #3B82F6 or #FFF)",
  })
  primaryColor?: string;
}
