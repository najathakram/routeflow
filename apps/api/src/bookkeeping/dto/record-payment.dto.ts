import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { Type } from "class-transformer";
import { PaymentMethod } from "@prisma/client";

export class RecordPaymentDto {
  @IsNumber() @Min(0.01) @Type(() => Number) amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  /** Row 498: a STAFF resend of a payment refused 409 DUPLICATE_PAYMENT_REF; recorded with one audit row. Ignored for any other role. */
  @IsOptional() @IsBoolean() recordAnyway?: boolean;
}
