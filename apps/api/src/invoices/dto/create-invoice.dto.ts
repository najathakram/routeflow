import {
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
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { CheckStatus, PaymentMethod } from "@prisma/client";
import { StripHtml } from "../../common/transforms/strip-html.transform";

export class CreateInvoiceItemDto {
  @IsString() description: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsNumber() @Min(0.001) qty: number;
  @IsNumber() @Min(0) unitPrice: number;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
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
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsOptional() @IsNumber() @Min(0) shippingFee?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() terms?: string;
  @IsOptional() @IsString() referenceNumber?: string;
  @IsOptional() @IsString() subject?: string;
  /** Carrier shipment tracking — set when goods ship via a carrier, not our route. */
  @IsOptional() @IsString() @MaxLength(64) shippingCarrier?: string;
  @IsOptional() @IsString() @MaxLength(128) shippingTrackingNumber?: string;
  /** If true, immediately send the invoice after creation (DRAFT → SENT). */
  @IsOptional() @IsBoolean() send?: boolean;
}

export class RecordInvoicePaymentDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsDateString() paidAt?: string;
  /** Date the money lands in the bank. May be in the future (post-dated check). */
  @IsOptional() @IsDateString() settledAt?: string | null;
  @IsOptional() @IsNumber() @Min(0) bankCharges?: number;
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
  @IsOptional() @IsNumber() @Min(0) bankCharges?: number;
  @IsOptional() @IsEnum(["DRAFT", "PAID", "VOID"]) status?: string;
}

export class AllocationDto {
  @IsString() @IsNotEmpty() invoiceId: string;
  @IsNumber() @Min(0.01) amount: number;
}

export class StandalonePaymentDto {
  @IsString() @IsNotEmpty() customerId: string;
  @IsNumber() @Min(0.01) totalAmount: number;
  @IsEnum(PaymentMethod) method: string;
  @IsOptional() @IsDateString() paidAt?: string;
  /** Date the money lands in the bank; applied to every row of the allocation group. */
  @IsOptional() @IsDateString() settledAt?: string | null;
  @IsOptional() @IsNumber() @Min(0) bankCharges?: number;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(["DRAFT", "PAID"]) status?: string;
  @IsArray()
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
  @IsOptional() @IsNumber() @Min(0) nsfFeeAmount?: number;
  /** The true landing date, meaningful with status = CLEARED; sets clearedAt and settledAt. */
  @IsOptional() @IsDateString() settledAt?: string;
}
