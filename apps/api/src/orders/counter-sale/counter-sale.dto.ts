import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { StripHtml } from "../../common/transforms/strip-html.transform";
import { RestrictionAckDto } from "../../selling-restrictions/dto/restriction-ack.dto";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";
import { InlineReturnLinesDto } from "../../returns/dto/capture-inline-return.dto";
import { TO_COLLECT_METHOD_VALUES, type ToCollectMethod } from "../../invoices/to-collect";

/** Mirrors `COUNTER_SALE_PAYMENT_METHOD_VALUES` in @routeflow/types (API source never value-imports that package). */
export const COUNTER_SALE_METHODS = ["CASH", "CARD", "CHECK", "ON_ACCOUNT"] as const;

/**
 * `CounterSaleItem` of the shared contract. `priceReason` maps to OrderItemDto.overrideReason. A `unitPrice` that
 * is a real change from the server's price is accepted only from a caller who passes `staffMay(role, "EDIT_LINE_PRICE")` (POS-5).
 */
export class CounterSaleItemDto {
  @IsUUID() productId: string;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) qty?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) boxes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) pieces?: number;
  @IsOptionalNotNull() @IsNumber() @Min(0) @Max(1_000_000) unitPrice?: number;
  @IsOptional() @IsString() @MaxLength(200) priceReason?: string;
  /** POS-3: an optional per-line note, stored on OrderItem.notes (max 200, HTML stripped). */
  @IsOptional() @StripHtml() @IsString() @MaxLength(200) note?: string;
}

/** `CounterSalePayment`: `amount` is cash tendered / amount paid; omitted = the exact balance. */
export class CounterSalePaymentDto {
  @IsIn(COUNTER_SALE_METHODS) method: (typeof COUNTER_SALE_METHODS)[number];
  @IsOptionalNotNull() @IsNumber() @Min(0) @Max(1_000_000) amount?: number;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
  /** Row 498 (SA-837b): the staff cashier's resend of a payment refused as a duplicate reference; staff roles only. */
  @IsOptional() @IsBoolean() recordAnyway?: boolean;
  /** CHECK only: the date written on the check, a strict YYYY-MM-DD. After the tenant's today = 400 COUNTER_CHECK_POSTDATED. */
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) checkDate?: string;
  /** SA-1026: "the check is not in hand yet"; valid only with ON_ACCOUNT (assertPaymentShape). Mirrors TO_COLLECT_METHOD_VALUES. */
  @IsOptional() @IsIn(TO_COLLECT_METHOD_VALUES) expectedMethod?: ToCollectMethod;
}

/**
 * `CounterSaleRequest` of the shared contract (packages/types/api/counter-sale.ts). Row 510: it extends the staff
 * restriction ack (`restrictionOverrides`, `warningHash`): after a 409 RESTRICTION_WARNING the till resubmits the SAME
 * cart with the SAME Idempotency-Key plus the ack. The ack is never part of the replay's cart comparison, so it can
 * never turn into a key conflict.
 */
export class CounterSaleDto extends RestrictionAckDto {
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsBoolean() walkIn?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CounterSaleItemDto)
  items: CounterSaleItemDto[];

  // W-887: ONE payment object. `@ValidateNested()` alone accepted a list (and an empty one) and saved the sale unpaid,
  // and let a missing payment through to the service; `@IsDefined() @IsObject()` refuse both (isObject excludes arrays).
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CounterSalePaymentDto)
  payment: CounterSalePaymentDto;

  @IsOptional() @StripHtml() @IsString() @MaxLength(5000) notes?: string;

  /**
   * W-863 (SA-945 PR-1): a return taken inside this sale, Create Order's own `inlineReturn` (the SAME dto, so there is one
   * return writer: create() -> applyReturn, L-167). Named customers only: a walk-in return is refunded, never credited (SA-932).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => InlineReturnLinesDto)
  inlineReturn?: InlineReturnLinesDto;
}
