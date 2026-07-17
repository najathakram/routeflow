import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class RefreshDto {
  /**
   * Optional: mobile clients send the refresh token in the body. Web clients may
   * instead present it via the httpOnly `rf_refresh` cookie (SEC-4 / F11-002),
   * in which case the body may be empty — the controller reads the cookie first
   * and falls back to this field.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
