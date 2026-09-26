import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * #2309 (SA-418): body for POST /auth/apple/nonce — mints the server-side nonce the
 * native client hands SHA-256(nonce) of to Apple, and returns the raw nonce back to us
 * on POST /auth/apple. Bound to the hash of {tenantSlug, context} (B349 form) so a
 * nonce minted for one tenant/context can't be replayed against another.
 */
export class AppleNonceDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  tenantSlug?: string;

  @IsIn(["staff", "buyer-standalone"])
  context!: "staff" | "buyer-standalone";
}
