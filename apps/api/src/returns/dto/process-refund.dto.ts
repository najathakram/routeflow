import { IsBoolean, IsIn, IsOptional } from "class-validator";

export const REFUND_METHODS = ["CREDIT_NOTE", "EXTERNAL_REFUND"] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

export class ProcessRefundDto {
  /**
   * CREDIT_NOTE (default) mints store credit for the customer — today's only behavior.
   * EXTERNAL_REFUND records that money was returned outside RouteFlow and mints nothing.
   */
  @IsOptional()
  @IsIn(REFUND_METHODS)
  method?: RefundMethod;

  /**
   * Deprecated and ignored. The endpoint never read a body, so the deployed web bundle sends
   * { restock } here; with forbidNonWhitelisted active, omitting this field would 400 every
   * in-flight client. Restocking is decided at receive() time. Remove after the old bundle ages out.
   */
  @IsOptional()
  @IsBoolean()
  restock?: boolean;
}
