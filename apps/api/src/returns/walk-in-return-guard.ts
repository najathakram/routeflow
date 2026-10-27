import type { JwtPayload } from "../auth/jwt-payload.interface";
import {
  type WalkInRefusalCause,
  walkInStoreCreditRefusal,
} from "../credit-notes/walk-in-credit-guard";
import { canRefundRole, loadSourceInvoicesState } from "./inline-return-refund";

/**
 * W-913 (SA-932 §B, §D): the inline capture's walk-in judgement, run BEFORE anything is written (no Return row, no
 * restock, no mint). A walk-in return is a refund at the till, so a capture that is NOT a refund (resolution
 * STORE_CREDIT, or an old phone build that sends none) is refused 409 WALK_IN_STORE_CREDIT_REFUSED, naming the cause:
 * the role cannot refund, the sale is not paid in full, it was paid with store credit, the return is worth nothing, or
 * (all of those fine) simply "refund it at the till". A REFUND capture keeps its own refusals (assertRefundable) and is
 * not judged here. Kept out of inline-returns.service.ts (size).
 */
export async function assertWalkInCaptureRefused(
  tx: any,
  args: {
    customerId: string;
    user: Pick<JwtPayload, "role">;
    priced: { total: number; chunks: Array<{ sourceInvoiceItemId: string | null }> };
  },
): Promise<void> {
  // isWalkIn is nullable (every legacy row is NULL): only an explicit true is a walk-in
  const customer = await tx.customer.findFirst({
    where: { id: args.customerId },
    select: { isWalkIn: true },
  });
  if (customer?.isWalkIn !== true) return;
  throw walkInStoreCreditRefusal(await walkInRefusalCause(tx, args));
}

/** The first cause that makes the till refund impossible, in the quote's `canRefund` order; else the plain refusal. */
async function walkInRefusalCause(
  tx: any,
  args: {
    user: Pick<JwtPayload, "role">;
    priced: { total: number; chunks: Array<{ sourceInvoiceItemId: string | null }> };
  },
): Promise<WalkInRefusalCause> {
  if (!canRefundRole(args.user.role)) return "ROLE";
  const src = await loadSourceInvoicesState(
    tx,
    args.priced.chunks.map((c) => c.sourceInvoiceItemId),
  );
  if (!src.paidInFull) return "NOT_PAID_IN_FULL";
  if (src.paidWithStoreCredit) return "PAID_WITH_STORE_CREDIT";
  if (!(args.priced.total > 0.001)) return "ZERO_TOTAL";
  return "STORE_CREDIT";
}
