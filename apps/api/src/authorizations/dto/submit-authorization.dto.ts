import {
  Equals,
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from "class-validator";

/**
 * Phase 4 (W6b): a BUYER self-serve license submission (RETAILER_SUBMITTED →
 * PENDING_REVIEW). Unlike the operator `CreateAuthorizationDto`, the buyer must
 * provide a real license number + expiry (the whole expiry lifecycle keys off it)
 * and explicitly consent to share it with the seller for verification.
 */
export class SubmitAuthorizationDto {
  @IsUUID()
  trackedCategoryId!: string;

  @IsString()
  @IsNotEmpty()
  licenseNumber!: string;

  @IsISO8601()
  expiresAt!: string;

  @IsOptional()
  @IsString()
  documentKey?: string;

  // Consent is a hard requirement — the buyer is sharing a regulatory document
  // with the seller. Recorded in the audit log (§8); there is no dedicated column.
  @IsBoolean()
  @Equals(true, { message: "You must consent to share this license with the seller." })
  shareConsent!: boolean;
}
