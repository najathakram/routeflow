import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MinLength } from "class-validator";
import { IsTenantTimeZone } from "../../common/is-tenant-time-zone.validator";

export class RegisterTenantDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9][a-z0-9-]{2,29}$/, {
    message:
      "slug must be 3-30 lowercase letters, numbers, or hyphens, and start with a letter or digit",
  })
  slug: string;

  @IsString()
  @IsNotEmpty()
  businessName: string;

  @IsEmail()
  adminEmail: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_]{3,30}$/, {
    message: "username must be 3-30 alphanumeric characters or underscores",
  })
  adminUsername: string;

  // B03: unify with every other password-setting flow (reset-password, buyer
  // register/change-password) — previously this DTO enforced only @MinLength(8),
  // so a password rejected by every other flow could still create a self-service
  // tenant admin, and the web signup form's weaker client-side rule (B03) was
  // silently the ONLY gate in practice.
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W])/, {
    message:
      "adminPassword must contain at least one uppercase letter, one lowercase letter, and one number or special character",
  })
  adminPassword: string;

  // SA-738: the business's IANA zone (the web signup sends the browser's). Optional so older
  // clients keep working; the service then writes the resolver's UTC fallback explicitly.
  @IsOptional()
  @IsString()
  @IsTenantTimeZone()
  timezone?: string;
}
