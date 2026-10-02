import { IsNotEmpty, IsString } from "class-validator";

/** #2309 (SA-418): body for POST /auth/apple/link (mirrors linkGoogleAccount's flow). */
export class AppleLinkDto {
  @IsString()
  @IsNotEmpty()
  identityToken!: string;

  @IsString()
  @IsNotEmpty()
  nonce!: string;
}
