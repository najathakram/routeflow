import { IsISO8601, IsOptional, IsString, MaxLength } from "class-validator";

/** #2648 / SA-535(a): the in-place PATCH body. Non-money fields only; unknown keys never reach it. */
export class UpdateCreditNoteDto {
  @IsOptional() @IsString() @MaxLength(450) reason?: string;

  /** null clears the expiry; a date must be in the future (checked only when it changes). */
  @IsOptional() @IsISO8601() expiresAt?: string | null;
}
