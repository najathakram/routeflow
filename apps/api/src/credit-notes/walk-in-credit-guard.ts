import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * W-913 (SA-932 §B, §D): a walk-in return is refunded at the till (cash, card or check), never kept as store credit on the
 * shared anonymous walk-in account. This is the ONE refusal every credit-note writer and the inline capture raise, so the
 * wording and the code cannot drift. Kept out of credit-notes.service.ts (size) and importable from `returns/` without a cycle.
 */

/** Why a walk-in return could not be taken (named in the 409 body as `cause`). */
export type WalkInRefusalCause =
  | "STORE_CREDIT" // the capture asked for store credit (or sent no resolution): the till refunds instead
  | "ROLE" // the caller may not refund (a driver)
  | "NOT_PAID_IN_FULL"
  | "PAID_WITH_STORE_CREDIT"
  | "ZERO_TOTAL";

export const WALK_IN_REFUSAL_MESSAGES: Record<WalkInRefusalCause, string> = {
  STORE_CREDIT: "Nothing changed. A walk-in return is refunded at the till.",
  ROLE: "Nothing changed. A walk-in return is refunded at the till. Ask office staff to refund it.",
  NOT_PAID_IN_FULL:
    "Nothing changed. A walk-in return is refunded at the till, and this sale isn't paid in full.",
  PAID_WITH_STORE_CREDIT:
    "Nothing changed. A walk-in return is refunded at the till, and this sale was paid with store credit.",
  ZERO_TOTAL: "Nothing changed. This return is worth $0.00, so there is nothing to refund.",
};

/** The coded 409 (`cause` names why; the default is the plain "refund it at the till"). */
export function walkInStoreCreditRefusal(cause: WalkInRefusalCause = "STORE_CREDIT") {
  return new ConflictException({
    code: API_ERROR_CODES.WALK_IN_STORE_CREDIT_REFUSED,
    message: WALK_IN_REFUSAL_MESSAGES[cause],
    cause,
  });
}

/**
 * Called FIRST in every credit-note writer (and before the capture restocks anything): refuses the tenant's walk-in
 * customer. `isWalkIn` is nullable and every legacy row is NULL, so only an explicit `true` refuses. An unknown customer
 * is left to the caller's own 404. `tx` is the caller's own client (a bare transaction or `forTenant()`).
 */
export async function assertCreditCustomerNotWalkIn(
  tx: { customer: { findFirst: (args: any) => Promise<any> } },
  customerId: string,
): Promise<void> {
  const customer = await tx.customer.findFirst({
    where: { id: customerId },
    select: { isWalkIn: true },
  });
  if (customer?.isWalkIn === true) throw walkInStoreCreditRefusal();
}
