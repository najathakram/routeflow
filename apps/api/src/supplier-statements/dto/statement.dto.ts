import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { StripHtml } from "../../common/transforms/strip-html.transform";

/**
 * One uploaded page of a supplier statement. Mirrors vendor-bills'
 * `ScanInvoiceFile` — the bytes are the document, `fileName`/`size` are
 * metadata only.
 */
export interface ScanStatementFile {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  size?: number;
}

/** The four kinds of activity a supplier statement line can carry. */
export type StatementLineKind = "INVOICE" | "PAYMENT" | "CREDIT" | "ADJUSTMENT";

export const STATEMENT_LINE_KINDS: readonly StatementLineKind[] = [
  "INVOICE",
  "PAYMENT",
  "CREDIT",
  "ADJUSTMENT",
];

/**
 * One line of the model's parsed statement, exactly as requested by the
 * extraction prompt. `amount` is always the line's face value (unsigned);
 * `kind` is what gives it direction against the running balance.
 */
export interface ParsedStatementLine {
  date: string | null;
  kind: StatementLineKind;
  refNumber: string | null;
  amount: number;
  runningBalance: number | null;
}

/** The full model output for one statement, before matching is layered on. */
export interface ParsedStatement {
  supplier: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  lines: ParsedStatementLine[];
  notes: string | null;
}

/**
 * One bill the operator confirmed paying off this statement, and how much.
 * `amount` allows 0 (a row the review screen pre-filled but the operator
 * zeroed out) — `applyStatement` skips anything at or under the house epsilon
 * rather than rejecting it, same as `RecordSupplierPaymentDto`'s allocations.
 */
export class ApplyStatementConfirmedDto {
  @IsUUID() billId!: string;
  @IsNumber() @Type(() => Number) @Min(0) amount!: number;
  /**
   * Which parsed statement line the operator picked this bill on. The review
   * screen's candidate picker offers every candidate of a line, not just the
   * matcher's suggestion, so the bill alone doesn't say which line backs it.
   * Optional — `applyStatement` falls back to the bill's own primary-pick
   * line — but always sent by the web client.
   */
  @IsOptional() @IsInt() @Type(() => Number) @Min(0) lineIndex?: number;
}

/**
 * Older local bills this statement doesn't mention at all, that the operator
 * separately decided to mark paid. Its own nested object, never folded into
 * `confirmed` — it is the most dangerous affordance in the flow and is
 * validated (and second-confirmed on the review screen) entirely on its own.
 */
export class ApplyStatementImpliedPaidDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  billIds!: string[];
}

/**
 * `POST /supplier-statements/:id/apply` body — the validated wire form of
 * `StatementApplyService`'s `ApplyStatementDto`. Structural compatibility is
 * compiler-enforced at the controller's call site, so the two cannot drift.
 * Validation matters more than usual here: this endpoint moves money, and the
 * service's own guards assume `confirmed` really is an array of numbers.
 */
export class ApplyStatementBodyDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ApplyStatementConfirmedDto)
  confirmed!: ApplyStatementConfirmedDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ApplyStatementImpliedPaidDto)
  impliedPaid?: ApplyStatementImpliedPaidDto;

  @IsOptional() @IsString() @MaxLength(1000) @StripHtml() notes?: string;
}
