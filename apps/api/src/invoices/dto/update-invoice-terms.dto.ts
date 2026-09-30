import { IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * WP3: narrow post-issue correction of exactly these four fields — never
 * items/discount/shipping/deposit, which still require a credit note or a
 * DRAFT edit. See `InvoicesService.updateTerms` for the status gate
 * (blocks VOID/WRITTEN_OFF) and the recomputeStatus re-run this triggers.
 */
export class UpdateInvoiceTermsDto {
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(40) paymentTermsLabel?: string;
  @IsOptional() @IsString() referenceNumber?: string;
  @IsOptional() @IsString() subject?: string;
}
