import { IsHexadecimal, IsOptional, IsString, Length, MaxLength, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * `POST /platform-admin/tenants/:id/business-profile[/preview]`. `profile` is a plain string on
 * purpose: an unknown key gets the API's own 400 `BUSINESS_PROFILE_UNKNOWN` (which the web picker
 * maps to fixed copy), not a generic validation message.
 */
export class ApplyBusinessProfileDto {
  @ApiProperty({ example: "shipping_wholesaler" })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  profile: string;

  @ApiPropertyOptional({ description: 'Audit reason; defaults to "Business profile: <label>"' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Confirm: the preview's `planFingerprint` is required, so the server applies only what was shown. */
export class ConfirmBusinessProfileDto extends ApplyBusinessProfileDto {
  @ApiProperty({ description: "planFingerprint from the preview this confirm follows" })
  @IsString()
  @IsHexadecimal()
  @Length(64, 64)
  planFingerprint: string;
}
