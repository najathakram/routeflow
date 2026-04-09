import { IsEmail, IsNotEmpty, IsString, Matches, MinLength } from "class-validator";

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

  @IsString()
  @MinLength(8)
  adminPassword: string;
}
