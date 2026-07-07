import { IsISO8601, IsOptional, IsString, IsUUID } from "class-validator";

export class CreateAuthorizationDto {
  @IsUUID()
  trackedCategoryId!: string;

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
