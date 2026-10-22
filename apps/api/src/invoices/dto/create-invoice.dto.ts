import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { CheckStatus, PaymentMethod } from "@prisma/client";
import type { KeyedWriterOpts, PaymentKeyRefs } from "../payment-idempotency";
import { StripHtml } from "../../common/transforms/strip-html.transform";
import { Trim } from "../../common/transforms/trim.transform";
import { SafeTextCell } from "../../common/transforms/safe-text-cell.transform";
import { MAX_SHIPPING_CARRIER, MAX_SHIPPING_TRACKING } from "../../orders/shipment-text";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";

export class CreateInvoiceItemDto {
  @IsString() description: string;
  @IsOptional() @IsUUID() productId?: string;
  /** SA-093a round 6: this line's source order line, server-validated against the invoice's own
   *  order. Round-trip it on every edit — omitting it drops the line to product-match fallback. */
  @IsOptional() @IsUUID() orderItemId?: string;
  @IsNumber() @Min(0.001) qty: number;
  @IsNumber() @Min(0) unitPrice: number;
  @IsOptionalNotNull() @IsNumber() @Min(0) discount?: number;
  /** A FRACTION (0.08875 = 8.875%). @Max(1): a percent sent by mistake is a 400, never 887.5% (R5-1, B296). */
  @IsOptionalNotNull() @IsNumber() @Min(0) @Max(1) taxRate?: number;
  /**
   * units_v1: sell this line by a unit of the product's ladder (Case, Pallet, Piece …); `qty` then
   * counts the unit (a whole number) and boxes/pieces/promoFreeUnits must be omitted. Behind
   * flag.units_v1; blank = the pack.
   */
  @IsOptional() @IsString() @MaxLength(64) unitLabel?: string | null;
  @IsOptional() @IsInt() @Min(0) boxes?: number;
  @IsOptional() @IsInt() @Min(0) pieces?: number;
  /**
   * BUY_N_GET_M snapshot: whole free SELLING units on this line (boxes for a
   * boxed line), carried from the source order line. The PATCH items path
   * delete-and-recreates every line, so a client editing a DRAFT MUST round-trip
   * it — omitting it re-prices an agreed $350 BOGO line to 12 × $35 = $420.
   * Clamped server-side to the line's own whole units − 1 (never a free line).
   */
  @IsOptional() @IsInt() @Min(0) promoFreeUnits?: number;
  /** Per-line note (buyer-visible; prints under the description on the PDF). */
  @IsOptional() @StripHtml() @IsString() @MaxLength(2000) notes?: string;
  /**
   * H3b: why a staff price moves off this customer's tier price (required when it moves off a SPECIAL one).
   * Trimmed, then judged by `decideStaffOverride`; stored on the line with the acting user.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  overrideReason?: string;
}

export class CreateInvoiceDto {
  @IsUUID() customerId: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceItemDto)
  items: CreateInvoiceItemDto[];
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsDateString() issueDate?: string;
  @IsOptionalNotNull() @IsNumber() @Min(0) discount?: number;
  @IsOptionalNotNull() @IsNumber() @Min(0) shippingFee?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() terms?: string;
  @IsOptional() @IsString() referenceNumber?: string;
  @IsOptional() @IsString() subject?: string;
  /** Carrier shipment tracking — set when goods ship via a carrier, not our route. Row 507: trimmed,
   *  capped, and a formula-led value is the coded 400 TEXT_CELL_FORMULA_LEAD (same as the shipment PATCH). */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SHIPPING_CARRIER)
  @Trim()
  @SafeTextCell()
  shippingCarrier?: string;
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SHIPPING_TRACKING)
  @Trim()
  @SafeTextCell()
  shippingTrackingNumber?: string;
  /** If true, immediately send the invoice after creation (DRAFT → SENT). */
  @IsOptional() @IsBoolean() send?: boolean;
  /**
   * Structured "Net 30"-style label, distinct from `terms` above (the long-form
   * Terms & Conditions text) — conflating the two was the documented historical
   * bug. Must always agree with `dueDate`: whichever string drove the due-date
   * math is what belongs here.
   */
  @IsOptional() @IsString() @MaxLength(40) paymentTermsLabel?: string;
  /**
   * Deliberately minimal deposit schedule (Tier 1): percent of the invoice total
   * due by depositDueDate. The dollar amount is always DERIVED at read time
   * (see InvoicesService), never stored.
   */
  @IsOptional() @IsNumber() @Min(0.01) @Max(99.99) depositPercent?: number;
  @IsOptional() @IsDateString() depositDueDate?: string;
}

/** Internal options of `recordPayment` (never part of a request body). SA-824: + the key's hooks. */
export interface RecordPaymentOpts extends KeyedWriterOpts<any> {
  /** The split counter tender's leg group (uuidv5 of orderId:legIndex), written IN the payment's create. */
  paymentGroupId?: string;
}

/** What `recordStandalonePayment` returns, and hands its `opts.inTx` hook (SA-818). */
export type StandalonePaymentResult = { payments: any[]; paymentGroupId: string; excess: number };

/** Internal options of `recordStandalonePayment` (never part of a request body). SA-824: + the key's hooks. */
export interface StandalonePaymentOpts extends KeyedWriterOpts<StandalonePaymentResult> {
  /**
   * Reject any allocation exceeding the invoice's live balance, computed
   * inside the transaction. Buyer-initiated payments compute their
   * oldest-first allocation BEFORE this call, outside the row locks, so a
   * concurrent operator payment can stale the preview — without this check
   * the stale allocation would overpay an invoice. Operator flows keep the
   * historical behavior (deliberate overpayment is allowed there).
   */
  assertAllocationsWithinBalance?: boolean;
  /** The operator's user id, for the deliberate-overpayment audit row. */
  actor?: string | null;
  /**
   * SA-818 (row 615): runs INSIDE this payment transaction, after the payment rows (and any
   * excess AdvancePayment) are written and before commit. A caller that must decide something
   * atomically with the money (the cash approval's PENDING -> APPROVED claim + link) does it
   * here: a throw rolls the money back with it. Absent -> behaviour is unchanged.
   */
  inTx?: (tx: any, result: StandalonePaymentResult, refs?: PaymentKeyRefs) => Promise<void>;
}

export class RecordInvoicePaymentDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsDateString() paidAt?: string;
  /** Date the money lands in the bank. May be in the future (post-dated check). */
  @IsOptional() @IsDateString() settledAt?: string | null;
  @IsOptionalNotNull() @IsNumber() @Min(0) bankCharges?: number;
  @IsOptional() @IsEnum(["DRAFT", "PAID"]) status?: string;
}

export class UpdatePaymentDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsDateString() paidAt?: string;
  /** Omit to preserve the stored bank date; send null to clear it. */
  @IsOptional() @IsDateString() settledAt?: string | null;
  @IsOptionalNotNull() @IsNumber() @Min(0) bankCharges?: number;
  @IsOptional() @IsEnum(["DRAFT", "PAID", "VOID"]) status?: string;
}

export class AllocationDto {
  @IsString() @IsNotEmpty() invoiceId: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
}

export class StandalonePaymentDto {
  @IsString() @IsNotEmpty() customerId: string;
  @IsNumber() @Min(0.01) totalAmount: number;
  @IsEnum(PaymentMethod) method: string;
  @IsOptional() @IsDateString() paidAt?: string;
  /** Date the money lands in the bank; applied to every row of the allocation group. */
  @IsOptional() @IsDateString() settledAt?: string | null;
  @IsOptionalNotNull() @IsNumber() @Min(0) bankCharges?: number;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(["DRAFT", "PAID"]) status?: string;
  @IsArray()
  // Post-dated check payments PR-1 (additive-only, no behavior change for any real request —
  // every existing caller allocates to a handful of invoices): caps a standalone payment's
  // waterfall allocation so a malformed/adversarial request can't force an unbounded per-row
  // fan-out.
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations: AllocationDto[];
}

export class WriteOffDto {
  @IsString() @IsNotEmpty() reason: string;
}

/** P5-12: advance a CHECK payment through its lifecycle. */
export class SetCheckStatusDto {
  @IsEnum(CheckStatus) status: CheckStatus;
  /** NSF fee to bill the customer when status = BOUNCED (omit or 0 = no fee). */
  @IsOptionalNotNull() @IsNumber() @Min(0) nsfFeeAmount?: number;
  /** The true landing date, meaningful with status = CLEARED; sets clearedAt and settledAt. */
  @IsOptional() @IsDateString() settledAt?: string;
}
