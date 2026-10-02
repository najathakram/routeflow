import { BadRequestException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B769 / SA-112 — the money totals of a standalone (multi-invoice) payment, decided BEFORE any
 * write: each allocation rounded to cents, their sum, and the excess that becomes an
 * AdvancePayment.
 *
 * SA-112 required two things:
 *   1. the excess is ROUNDED, so a sub-cent float is never written as an advance;
 *   2. the allocations may never add up to MORE than the payment. That used to leave a NEGATIVE
 *      excess that `Math.max(0, excess)` silently dropped, recording more paid against invoices
 *      than the money actually received. It is now a 400, before a payment number is reserved.
 */
export function standaloneAllocationTotals(dto: {
  totalAmount: number;
  allocations: ReadonlyArray<{ amount: number }>;
}): { allocatedTotal: number; excess: number } {
  const total = roundMoney(Number(dto.totalAmount));
  const allocatedTotal = roundMoney(
    dto.allocations.reduce((sum, a) => sum + roundMoney(Number(a.amount)), 0),
  );
  if (allocatedTotal > total) {
    throw new BadRequestException({
      code: API_ERROR_CODES.ALLOCATIONS_EXCEED_PAYMENT,
      message:
        `The allocations add up to $${allocatedTotal.toFixed(2)}, more than the ` +
        `$${total.toFixed(2)} payment. Lower an allocation or raise the payment amount.`,
      allocatedTotal,
      totalAmount: total,
    });
  }
  return { allocatedTotal, excess: roundMoney(total - allocatedTotal) };
}
