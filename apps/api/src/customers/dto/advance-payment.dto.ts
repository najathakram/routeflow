import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
} from "class-validator";
import { PaymentMethod } from "@prisma/client";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";

/** B769: the endpoint took `dto: any` — no validation at all on a money-writing field. */
export class CreateAdvancePaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsDateString() receivedAt?: string;
}

/** B769: the endpoint took `dto: any` — no validation at all on a money-writing field. */
export class ApplyAdvancePaymentDto {
  @IsUUID() invoiceId: string;

  @IsOptionalNotNull()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;
}
