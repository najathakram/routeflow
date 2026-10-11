import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Body for POST /auth/google/start. The invite token (a secret) travels in this body, never in a
 * URL, and is stored server-side against the OAuth nonce: the signed `state` carries only the
 * nonce reference.
 */
export class GoogleStartDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  tenant?: string;

  @IsOptional()
  @IsIn(["portal", "staff", "buyer-standalone"])
  context?: "portal" | "staff" | "buyer-standalone";

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  inviteToken?: string;
}
