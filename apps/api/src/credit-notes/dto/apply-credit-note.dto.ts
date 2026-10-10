import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from "class-validator";

/**
 * #2416: POST /credit-notes/:id/apply. Without a class, the global ValidationPipe had no metadata
 * and a missing invoiceId reached the service as undefined, which surfaced as a 500.
 */
export class ApplyCreditNoteDto {
  @IsString() @IsNotEmpty() invoiceId!: string;
  @IsOptional() @IsNumber() @Min(0.01) amount?: number;
}

/** #2416: POST /credit-notes/:id/unapply, the same invoiceId guard. */
export class UnapplyCreditNoteDto {
  @IsString() @IsNotEmpty() invoiceId!: string;
}
