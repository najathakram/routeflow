import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class UpdateEmailConfigDto {
  @IsOptional()
  @IsString()
  smtpHost?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  smtpPort?: number;

  @IsOptional()
  @IsBoolean()
  smtpSecure?: boolean;

  @IsOptional()
  @IsString()
  smtpUser?: string;

  /** Plain-text password — will be encrypted before storage */
  @IsOptional()
  @IsString()
  smtpPassword?: string;

  @IsOptional()
  @IsString()
  smtpFromName?: string;

  @IsOptional()
  @IsEmail()
  smtpFromEmail?: string;
}
