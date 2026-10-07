import { ServiceUnavailableException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * B1201: create() commits the order BEFORE its credit tx, so a credit tx that exhausts its retries
 * (`retryCreditTx`'s 503 LOCK_UNAVAILABLE "Nothing was saved") must not claim that - the order WAS
 * saved. Re-code that one failure as 503 ORDER_SAVED_CREDITS_PENDING carrying `orderId`. The client
 * opens the saved order (the operator applies the credits there); a keyed replay NEVER re-applies
 * credits (no money write is decided by a heuristic). Any other error propagates untouched.
 */
export async function savedCreditsPending(orderId: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    const body = err instanceof ServiceUnavailableException ? err.getResponse() : null;
    if ((body as { code?: string } | null)?.code !== API_ERROR_CODES.LOCK_UNAVAILABLE) throw err;
    throw new ServiceUnavailableException({
      code: API_ERROR_CODES.ORDER_SAVED_CREDITS_PENDING,
      orderId,
      message:
        "The order was saved, but the credit notes weren't applied. Apply them on the order.",
    });
  }
}

/**
 * B1201: READ-ONLY hint on a keyed replay's response. `creditsPending` is true when the request chose
 * credit notes but the order holds no credit intent, so a lost-response replay can show the same
 * "apply them on the order" message. It only drives that message and never triggers a write.
 */
export async function withCreditsPendingHint<T extends { id: string }>(
  prisma: PrismaService,
  order: T,
  chosen: ReadonlyArray<unknown> | undefined,
): Promise<T & { creditsPending?: boolean }> {
  const tenantId = prisma.getTenantId();
  if (!chosen?.length || !tenantId) return order;
  const held = await prisma
    .forTenant()
    .orderCreditNote.count({ where: { orderId: order.id, tenantId } });
  return { ...order, creditsPending: held === 0 };
}
