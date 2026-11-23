import { IsOptional, IsString, IsIn, IsBoolean, IsNumber, Min, Max } from "class-validator";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";

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

  // SA-1031: SystemConfig `invoice.hideBarcodes`. When true the invoice PDF prints no product barcode (line or piece) and no
  // code under it. Absent = shown, so every tenant stays on until an admin turns it off.
  @IsOptional()
  @IsBoolean()
  hideBarcodes?: boolean;

  // Owner ruling 2026-11-04: SystemConfig `invoice.hidePerPiece`. When true the Per piece column (SA-1029) is left off the
  // invoice page, the PDF and the email. Absent = shown, so every business keeps today's look until an admin turns it off.
  @IsOptional()
  @IsBoolean()
  hidePerPiece?: boolean;

  // R6a: SystemConfig `invoice.hideAmountPaid`. When true the invoice PDF (and the counter's Print invoice) and the invoice
  // email leave the Amount Paid line (and the PDF's Payment History block) off. Absent = shown. Credit/advance lines never hide.
  @IsOptional()
  @IsBoolean()
  hideAmountPaid?: boolean;

  // R6a: SystemConfig `invoice.hideBalanceDue`. When true the invoice PDF and the invoice email leave the Balance Due line off
  // (not the reminder, not the portal). Absent = shown.
  @IsOptional()
  @IsBoolean()
  hideBalanceDue?: boolean;

  // SA-1197: SystemConfig `invoice.showAccountBalance`. When true an account customer's invoice PDF, invoice email and
  // invoice page print the open balance block under Balance Due. Absent = off (only the string "true" turns it on).
  @IsOptional()
  @IsBoolean()
  showAccountBalance?: boolean;

  // WP-D1: tenant-wide deposit policy. Absent/0 = no tenant deposit default (a
  // customer's own defaultDepositPercent, or no deposit at all, still applies via
  // InvoicesService.resolveDefaultTerms's effectiveDepositPercent resolution). Send 0 to clear: null is refused (652).
  @IsOptionalNotNull()
  @IsNumber()
  @Min(0)
  @Max(100)
  depositDefaultPercent?: number;

  // When true, an order's mirror invoice is issued (SENT, no email) at placement
  // instead of staying a DRAFT until delivery — see InvoicesService.createInvoiceFromOrder.
  @IsOptional()
  @IsBoolean()
  depositCollectAtOrder?: boolean;

  // SA-436 (#2401): TenantConfig.creditAutoApplyOnSend. When true, sending an invoice sweeps the
  // customer's open credit notes onto it oldest-first. OFF by default (owner ruling).
  @IsOptional()
  @IsBoolean()
  creditAutoApplyOnSend?: boolean;
}
