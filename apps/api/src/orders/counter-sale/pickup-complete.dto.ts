import { IsOptional, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CounterSalePaymentDto } from "./counter-sale.dto";

/** `PickupCompleteRequest` of the shared contract (packages/types/api/counter-sale.ts). */
export class PickupCompleteDto {
  /** Omit to hand the order over unpaid (on account). A walk-in must pay. */
  @IsOptional()
  @ValidateNested()
  @Type(() => CounterSalePaymentDto)
  payment?: CounterSalePaymentDto;
}
