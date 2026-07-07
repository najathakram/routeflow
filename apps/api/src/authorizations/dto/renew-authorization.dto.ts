import { IsISO8601, IsOptional, IsString } from "class-validator";

export class RenewAuthorizationDto {
  @IsOptional()
  @IsString()
  licenseNumber?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  documentKey?: string;
}
