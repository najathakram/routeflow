import { IsString, MinLength, MaxLength, Matches, IsEmail, IsOptional } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateTenantDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{2,29}$/, { message: "slug must be 3-30 lowercase alphanumeric/hyphen chars" })
  slug: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  businessName: string;

  @ApiProperty()
  @IsEmail()
  adminEmail: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  adminUsername: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  adminPassword: string;

  @ApiPropertyOptional({ enum: ["STARTER", "PROFESSIONAL", "ENTERPRISE"], default: "STARTER" })
  @IsOptional()
  @IsString()
  plan?: string;
}
