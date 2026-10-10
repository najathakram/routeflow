import { Transform } from "class-transformer";
import { IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { REFUND_TENDERS, type RefundTender } from "../inline-return-refund";

/**
 * SA-727: `POST /returns/inline/:id/refund`. The client never types an amount to refund: `expectedAmount` is
 * the figure the quote showed, and the server refuses (409 REFUND_AMOUNT_CHANGED) unless it equals the
 * amount it computes for the captured return. The tender is recorded in the audit trail only (the list is mirrored in `@routeflow/types` as
 * `INLINE_REFUND_TENDER_VALUES`, pinned equal by inline-returns-quote-response-parity.spec.ts).
 */
export class RefundInlineReturnDto {
  @IsIn(REFUND_TENDERS)
  tender!: RefundTender;

  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  expectedAmount!: number;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  reason?: string;
}
