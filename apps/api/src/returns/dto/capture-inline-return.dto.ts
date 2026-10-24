import { Transform, Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { RequireBoxesOrPiecesPositive } from "./require-boxes-or-pieces.validator";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";

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

  /**
   * #2695 (SA-557): a staff (OPERATOR/TENANT_ADMIN) per-line CREDIT price, per SELLING unit (one
   * box when the product is boxed), LOWER-ONLY — capped at the engine's own default for each
   * chunk (`applyCreditOverride`). Requires `overrideReason`, on the quote AND the capture, so both
   * price the same chunks; a DRIVER/CUSTOMER request carrying either field is a 400.
   */
  @IsOptionalNotNull()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  creditUnitPrice?: number;

  /** #2695: why the credit price was overridden — required with `creditUnitPrice`. Trimmed BEFORE
   * the length check, so 200 real characters padded with spaces are not refused. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  overrideReason?: string;

  /**
   * B961 / SA-071c: a staff (OPERATOR/TENANT_ADMIN) confirmation that this line's over-return chunk (goods the customer
   * already returned or was credited for) really is being returned, WITH a reason (audited with the actor). Required on the
   * capture when the quote flagged `alreadyReturned`; a DRIVER carrying it is a 400 (a driver's capture is held for the office).
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  alreadyReturnedReason?: string;
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
  @MaxLength(128)
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

  /**
   * SA-727: how the return will be resolved. STORE_CREDIT (the default, byte-identical to before) mints the
   * credit note right after the capture. REFUND restocks and records the return (RECEIVED) WITHOUT minting a
   * credit note, so `POST /returns/inline/:id/refund` can resolve it in cash/card/check; it needs an office
   * role and every source invoice paid in full (409 REFUND_NEEDS_PAID_INVOICE before anything is written).
   */
  @IsOptional()
  @IsIn(["STORE_CREDIT", "REFUND"])
  resolution?: "STORE_CREDIT" | "REFUND";

  /** The order that CARRIES the credit — never the (possibly different) order(s) the
   * returned goods were originally sold on (`ReturnItem.sourceOrderId`, resolved by the
   * matching engine per item). */
  @IsString()
  @IsNotEmpty()
  orderId!: string;

  /**
   * SA-740 (row 190): the sale the goods are from, when it is not the carrying order. A walk-in capture defaults it to
   * `orderId` (the counter flow carries the return on the sale itself); a named customer's capture is unpinned unless
   * this is sent. The same rules as `QuoteInlineReturnDto.sourceOrderId`; send the SAME value the quote priced.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sourceOrderId?: string;
}
