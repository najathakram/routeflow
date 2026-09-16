import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString, Matches, MinLength } from "class-validator";

/**
 * F1-class fix (2026-09-12): `PlatformAdminController.createTenantAdmin` used
 * to type its body as an inline `{ username: string; email: string;
 * password?: string }` object literal — NestJS's ValidationPipe reflects on
 * the parameter's METATYPE to decide whether to validate at all, and an
 * inline type literal has no runtime metatype (it erases to `Object`), so
 * `whitelist`/`forbidNonWhitelisted`/every `class-validator` decorator on
 * this route was silently skipped entirely — worse than B03's weak regex,
 * this was NO validation at all on a body that can set a permanent
 * TENANT_ADMIN password (`forcePasswordChange` is only set when the
 * password is auto-generated). A real DTO class restores validation and
 * lets the same platform-wide password policy apply here too.
 */
export class CreateTenantAdminDto {
  @ApiProperty({ example: "acme_admin" })
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,30}$/, {
    message: "username must be 3-30 alphanumeric characters or underscores",
  })
  username: string;

  @ApiProperty({ example: "owner@acme.example" })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({
    description: "Admin password. If omitted, a secure temporary password is auto-generated.",
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W])/, {
    message:
      "password must contain at least one uppercase letter, one lowercase letter, and one number or special character",
  })
  password?: string;
}
