import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { PaymentMethod } from "@prisma/client";
import { StripHtml } from "../../common/transforms/strip-html.transform";

/**
 * One bill's share of a lump-sum supplier payment. `amount` allows 0 (a
 * pre-filled waterfall row a client didn't end up using) — `recordSupplierPayment`
 * skips anything at or under the house epsilon rather than rejecting it.
 */
export class SupplierAllocationDto {
  @IsString() vendorBillId!: string;
  @IsNumber() @Type(() => Number) @Min(0) amount!: number;
}

/**
 * POST /vendor-bills/payments/record body — the AP mirror of AR's
 * `StandalonePaymentDto` (`invoices/dto/create-invoice.dto.ts`). One
 * `paymentGroupId` is stamped across every `BillPayment` this produces so a
 * single lump-sum supplier payment split across N bills reads as one event.
 * Any amount left over after allocations becomes a `SupplierCredit` instead
 * of being rejected — see `VendorBillsService.recordSupplierPayment`.
 */
export class RecordSupplierPaymentDto {
  @IsString() supplierId!: string;
  @IsNumber() @Type(() => Number) @IsPositive() totalAmount!: number;
  @IsEnum(PaymentMethod) method!: PaymentMethod;
  @IsOptional() @IsDateString() paidAt?: string;
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
  @IsOptional() @IsString() @MaxLength(1000) @StripHtml() notes?: string;
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SupplierAllocationDto)
  allocations!: SupplierAllocationDto[];
}
