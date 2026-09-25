import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { RequireBoxesOrPiecesPositive } from "./require-boxes-or-pieces.validator";

/** Byte-identical to `ReturnsService`'s `VALID_RETURN_REASONS` (returns.service.ts) —
 * class-validator decorators need a literal array, so this can't just import the const, but
 * the two are pinned together by `returns-reason-parity.spec.ts`. */
const CAPTURE_REASONS = [
  "DAMAGED",
  "WRONG_ITEM",
  "CUSTOMER_REFUSED",
  "QUALITY_ISSUE",
  "EXCESS_ORDER",
] as const;

/** Same shape as `QuoteInlineReturnItemDto` (SA-128/B814) — see that file's doc comment for
 * why `boxes`/`pieces` are required and bare `qty` is retired. Quote and capture must never
 * diverge here: the same pricing engine (`priceInlineReturn`) reads both. */
export class CaptureInlineReturnItemDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  /** Still accepted (existing callers send `qty: 1`) but IGNORED — see
   * `QuoteInlineReturnItemDto.qty`. */
  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;

  @IsInt()
  @Min(0)
  @RequireBoxesOrPiecesPositive()
  boxes!: number;

  @IsInt()
  @Min(0)
  pieces!: number;

  /** Per-item reason override; falls back to the capture's own `reason` when omitted. */
  @IsOptional()
  @IsIn(CAPTURE_REASONS)
  reason?: string;

  @IsOptional()
  @IsString()
  condition?: string;

  /** Defaults to the reason-driven convention (`ReturnsService`'s `NO_RESTOCK_REASONS`) when
   * omitted — an explicit value always wins. */
  @IsOptional()
  @IsBoolean()
  restock?: boolean;
}

/**
 * Returns Inside Order Creation — PR-1c: `POST /returns/inline/capture`. Captures a return
 * against an existing "carrying" order (`orderId`) — prices it (the SAME engine `POST
 * /returns/inline/quote` uses), restocks, reverses the regulated ledger, and either issues a
 * standalone credit note or holds the whole credit for approval above the driver cap (N-5).
 */
export class InlineReturnLinesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CaptureInlineReturnItemDto)
  items!: CaptureInlineReturnItemDto[];

  /** Required for a DRIVER caller (M8) — see `QuoteInlineReturnDto`. */
  @IsOptional()
  @IsString()
  routeRunStopId?: string;

  /** Client nonce for this capture tray — `@@unique([tenantId, returnKey])` makes a retried
   * submission (offline replay, double-tap) resolve to the SAME row instead of a duplicate.
   * REQUIRED (re-review LOW): no client calls this route yet, so there is no back-compat
   * cost to closing off an unkeyed capture — every capture must be replay-safe from day one
   * rather than opting in later. */
  @IsString()
  @IsNotEmpty()
  returnKey!: string;

  @IsOptional()
  @IsIn(CAPTURE_REASONS)
  reason?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsArray()
  photoUrls?: string[];
}

/**
 * The standalone capture: an inline return against an EXISTING carrying order. Inside an order
 * create/edit the same lines arrive nested as `inlineReturn` (#2094, SA-194) with customer and
 * order DERIVED from the document, so neither is ever client-supplied there.
 */
export class CaptureInlineReturnDto extends InlineReturnLinesDto {
  @IsString()
  @IsNotEmpty()
  customerId!: string;

  /** The order that CARRIES the credit — never the (possibly different) order(s) the
   * returned goods were originally sold on (`ReturnItem.sourceOrderId`, resolved by the
   * matching engine per item). */
  @IsString()
  @IsNotEmpty()
  orderId!: string;
}
