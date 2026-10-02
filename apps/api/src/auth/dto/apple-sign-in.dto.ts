import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * #2309 (SA-418): body for POST /auth/apple. `identityToken` + `authorizationCode`
 * come from expo-apple-authentication (native iOS only). `fullName` arrives only on
 * the FIRST sign-in — Apple never sends it again.
 */
export class AppleSignInDto {
  @IsString()
  @IsNotEmpty()
  identityToken!: string;

  @IsString()
  @IsNotEmpty()
  authorizationCode!: string;

  @IsString()
  @IsNotEmpty()
  nonce!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  tenantSlug?: string;

  @IsIn(["staff", "buyer-standalone"])
  context!: "staff" | "buyer-standalone";

  @IsOptional()
  @IsString()
  @MaxLength(256)
  fullName?: string;
}
