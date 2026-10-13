import { IsBoolean, IsIn, IsOptional } from "class-validator";
import { REFUND_TENDERS, type RefundTender } from "../inline-return-refund";

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
   * SA-740r2: how a recorded refund (EXTERNAL_REFUND) was paid out: CASH | CARD | CHECK, stored in `Return.refundTender`
   * (CARD is CREDIT_CARD). OPTIONAL until the mobile build that sends it is the minimum: omitted stores null (the day's
   * `tenderKnown` stays false). A tender with method CREDIT_NOTE (store credit has none) is a 400.
   */
  @IsOptional()
  @IsIn(REFUND_TENDERS)
  tender?: RefundTender;

  /**
   * Deprecated and ignored. The endpoint never read a body, so the deployed web bundle sends
   * { restock } here; with forbidNonWhitelisted active, omitting this field would 400 every
   * in-flight client. Restocking is decided at receive() time. Remove after the old bundle ages out.
   */
  @IsOptional()
  @IsBoolean()
  restock?: boolean;
}
