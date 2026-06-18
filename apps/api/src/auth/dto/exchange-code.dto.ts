import { IsString, IsNotEmpty, MaxLength } from "class-validator";

/**
 * F8-001: body for POST /auth/google/exchange — trades a single-use opaque code
 * (delivered in the OAuth callback redirect) for the token bundle.
 */
export class ExchangeCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  code!: string;
}
