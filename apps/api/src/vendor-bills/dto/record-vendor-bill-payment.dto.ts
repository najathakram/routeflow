import { IsEnum, IsNumber, IsOptional, IsPositive, IsString } from "class-validator";
import { PaymentMethod } from "@prisma/client";

/**
 * POST /vendor-bills/:id/payments body. F10-004: the old `@Body() any` let a
 * caller post a negative or zero `amount`, which reduced totalPaid and could
 * flip the bill's status — corrupting AP balances. `@IsPositive` blocks that at
 * the HTTP boundary; the service also re-checks `amount > 0` for direct callers.
 */
export class RecordVendorBillPaymentDto {
  @IsNumber() @IsPositive() amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
}
