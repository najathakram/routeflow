import { IsBoolean, IsOptional, IsString, IsUrl } from "class-validator";

export class UpdateGoogleOAuthConfigDto {
  @IsOptional()
  @IsString()
  clientId?: string;

  /** Plain-text secret — will be encrypted before storage */
  @IsOptional()
  @IsString()
  clientSecret?: string;

  @IsOptional()
  @IsUrl()
  callbackUrl?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
