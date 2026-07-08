import { IsNumber, IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CompleteStopDto } from "./complete-stop.dto";

export class StopPaymentDto {
  @IsString() invoiceId: string;
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
