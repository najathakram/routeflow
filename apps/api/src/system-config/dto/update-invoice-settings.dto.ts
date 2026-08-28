import { IsOptional, IsString, IsIn, IsBoolean, IsNumber, Min, Max } from "class-validator";

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

  // WP-D1: tenant-wide deposit policy. Absent/0 = no tenant deposit default (a
  // customer's own defaultDepositPercent, or no deposit at all, still applies via
  // InvoicesService.resolveDefaultTerms's effectiveDepositPercent resolution).
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  depositDefaultPercent?: number;

  // When true, an order's mirror invoice is issued (SENT, no email) at placement
  // instead of staying a DRAFT until delivery — see InvoicesService.createInvoiceFromOrder.
  @IsOptional()
  @IsBoolean()
  depositCollectAtOrder?: boolean;
}
