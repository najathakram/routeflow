import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { TENDER_METHOD_VALUES, TENDER_RULES, type TenderMethod } from "@routeflow/pricing";
import { StripHtml } from "../../common/transforms/strip-html.transform";
import type { CounterPaymentMethod } from "./counter-sale-payment";

/**
 * The methods the counter takes: the pricing counter row itself (one source, never a second typed list).
 * `COUNTER_SALE_PAYMENT_METHOD_VALUES` in @routeflow/types mirrors it (API source never value-imports that
 * package; counter-sale-methods-parity.spec.ts pins the two set-equal).
 */
export const COUNTER_SALE_METHODS = TENDER_RULES.counter.allowed as readonly CounterPaymentMethod[];

/**
 * `CounterSaleItem` of the shared contract. `priceReason` maps to OrderItemDto.overrideReason. A `unitPrice` that
 * is a real change from the server's price is accepted only from a caller who passes `staffMay(role, "EDIT_LINE_PRICE")` (POS-5).
 */
export class CounterSaleItemDto {
  @IsUUID() productId: string;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) qty?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) boxes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) pieces?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) unitPrice?: number;
  @IsOptional() @IsString() @MaxLength(200) priceReason?: string;
  /** POS-3: an optional per-line note, stored on OrderItem.notes (max 200, HTML stripped). */
  @IsOptional() @StripHtml() @IsString() @MaxLength(200) note?: string;
}

/** `CounterSalePayment`: `amount` is cash tendered / amount paid; omitted = the exact balance. */
export class CounterSalePaymentDto {
  @IsIn(COUNTER_SALE_METHODS) method: CounterPaymentMethod;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) amount?: number;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
}

/**
 * One leg of a split tender. The method list is TENDER_METHOD_VALUES (so STORE_CREDIT gets its own coded 400,
 * TENDER_METHOD_NOT_ALLOWED, from counter-sale-legs rather than a bare "must be one of"); the counter's own
 * limits (leg count, one cash leg, ON_ACCOUNT alone, whole cents) are TENDER_RULES.counter's, read there.
 */
export class TenderLegDto {
  @IsIn(TENDER_METHOD_VALUES) method: TenderMethod;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) amount?: number;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
}

/** `CounterSaleRequest` of the shared contract (packages/types/api/counter-sale.ts). */
export class CounterSaleDto {
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsBoolean() walkIn?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CounterSaleItemDto)
  items: CounterSaleItemDto[];

  /** Exactly one of `payment` (the one-leg alias) and `payments` (resolveLegs refuses both and neither). */
  @IsOptional()
  @ValidateNested()
  @Type(() => CounterSalePaymentDto)
  payment?: CounterSalePaymentDto;

  /**
   * The split tender. The array is only bounded here against abuse: more legs than the counter allows is the
   * coded 400 COUNTER_TOO_MANY_LEGS, which a tight @ArrayMaxSize would turn into an uncoded one.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TenderLegDto)
  payments?: TenderLegDto[];

  @IsOptional() @StripHtml() @IsString() @MaxLength(5000) notes?: string;
}
