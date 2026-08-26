import { IsOptional, IsString, IsIn, IsBoolean } from "class-validator";

// Canonical payment-terms allow-list. Imported by the customer/supplier
// default-terms DTOs (which append "" for "clear the override"), so adding a
// term here widens every surface at once instead of leaving a stale copy
// rejecting it with a 400.
export const VALID_TERMS = ["Due on Receipt", "Net 15", "Net 30", "Net 45", "Net 60"];

export class UpdateInvoiceSettingsDto {
  @IsOptional()
  @IsString()
  @IsIn(VALID_TERMS, { message: "defaultTerms must be one of: " + VALID_TERMS.join(", ") })
  defaultTerms?: string;

  @IsOptional()
  @IsBoolean()
  hideOriginalPrice?: boolean;
}
