import { IsBoolean, IsOptional } from "class-validator";

export class ReceiveReturnDto {
  /**
   * false = "we are not keeping these goods": skip ALL restocking and persist restock=false on
   * every ReturnItem, so a later cancel() stays symmetric. Omitted/true keeps the per-item flags
   * chosen when the return was created. The regulated ledger reversal happens either way.
   */
  @IsOptional()
  @IsBoolean()
  restock?: boolean;
}
