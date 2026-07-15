import { IsNumber, IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CompleteStopDto } from "./complete-stop.dto";

export class StopPaymentDto {
  // The invoice is resolved SERVER-side from the delivered orders — clients no
  // longer send this (Order has no invoiceId scalar, so it was always undefined
  // and every at-door payment silently vanished). Kept optional for backward
  // compatibility; the server ignores it.
  @IsOptional() @IsString() invoiceId?: string;
  @IsNumber() amount: number;
  @IsString() method: string;
}

/**
 * Phase 4 (W7b): promoted from the inline `@Body()` on
 * POST /route-runs/:id/stops/:stopId/complete-with-payment. Same POD capture as
 * CompleteStopDto plus the atomic payment (RF-005).
 */
export class CompleteWithPaymentDto extends CompleteStopDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => StopPaymentDto)
  payment?: StopPaymentDto;
}
