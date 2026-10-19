import { Transform, Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { RequireBoxesOrPiecesPositive } from "./require-boxes-or-pieces.validator";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";

export class QuoteInlineReturnItemDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  /**
   * SA-128/B814: `boxes`/`pieces` are REQUIRED, and bare `qty` is retired on this endpoint.
   * A product can have no `unitsPerBox` anywhere (no live snapshot, no candidate invoice
   * line with one either) for two reasons that look identical from here: it's genuinely
   * never sold in boxes (`qty` would correctly mean pieces), or it WAS boxed and that
   * information was lost (`qty` was meant as boxes, and silently reading it as pieces
   * under-credits the customer by a factor of the pack size). Nothing in the request or the
   * order history can tell those two apart, so guessing is unsafe either way — every caller
   * must state the split explicitly, even for an unpacked line (`{ boxes: 0, pieces: N }`).
   * `qty` is still accepted (existing callers send `qty: 1`) but is IGNORED once
   * `boxes`/`pieces` are present, which they now always must be.
   */
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

export class QuoteInlineReturnDto {
  @IsString()
  @IsNotEmpty()
  customerId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => QuoteInlineReturnItemDto)
  items!: QuoteInlineReturnItemDto[];

  /** Required for a DRIVER caller (M8): the stop this return is being captured at —
   * proves the caller is at a customer's stop on their own IN_PROGRESS run. Ignored
   * for OPERATOR/TENANT_ADMIN callers. */
  @IsOptional()
  @IsString()
  routeRunStopId?: string;

  /**
   * SA-740 (row 190): the sale this return is from. REQUIRED for a walk-in (decided server-side from
   * `customer.isWalkIn`, never from this body): the quote refuses without it (400 SOURCE_SALE_REQUIRED). A named
   * customer may send it to pin the matching to that one order; without it their return still spills across orders.
   * Must be the customer's own counter sale or delivered order in this tenant (400 SOURCE_SALE_INVALID).
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sourceOrderId?: string;
}
