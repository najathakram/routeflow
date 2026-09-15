import {
  IsString,
  MinLength,
  MaxLength,
  Matches,
  IsEmail,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  Max,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { PLAN_KEYS } from "../../billing/plan-catalog.constants";
import { TENANT_CLASS_VALUES } from "@routeflow/types";

export class CreateTenantDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{2,29}$/, {
    message: "slug must be 3-30 lowercase alphanumeric/hyphen chars",
  })
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

  @ApiPropertyOptional({
    description: "Admin password. If omitted, a secure temporary password is auto-generated.",
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  adminPassword?: string;

  @ApiPropertyOptional({ enum: PLAN_KEYS, default: "STARTER" })
  @IsOptional()
  @IsIn(PLAN_KEYS)
  plan?: (typeof PLAN_KEYS)[number];

  @ApiPropertyOptional({
    description: "Trial length override in days (default: TRIAL_LENGTH_DAYS)",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  trialLengthDays?: number;

  @ApiPropertyOptional({
    enum: TENANT_CLASS_VALUES,
    description:
      "Explicit tenant class override. Defaults to the slug's own classification " +
      "(classifyTenantSlug); a caller-supplied PRODUCTION that contradicts the slug's own " +
      "class is rejected (REG-743-F7).",
  })
  @IsOptional()
  @IsIn(TENANT_CLASS_VALUES)
  class?: (typeof TENANT_CLASS_VALUES)[number];
}
