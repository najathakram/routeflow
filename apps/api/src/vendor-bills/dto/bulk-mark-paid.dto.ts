import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { PaymentMethod } from "@prisma/client";

/**
 * POST bookkeeping/bulk-mark-paid body. Landmine 6: neither existing bulk
 * endpoint (vendor-bills bulkDelete, expenses/batch-status) uses a
 * class-validator DTO — both bind an inline `@Body()` type the ValidationPipe
 * can't see. Breaking that convention here on purpose: this one moves money.
 *
 * `ids` may be VendorBill ids, Expense ids, or a mix of both — see
 * `BookkeepingService.bulkMarkPaid` for how each is resolved.
 */
export class BulkMarkPaidDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  ids: string[];

  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsOptional()
  @IsDateString()
  paidAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}
