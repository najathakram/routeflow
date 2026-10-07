import { ServiceUnavailableException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B1201: create() commits the order BEFORE its credit tx, so a credit tx that exhausts its retries
 * (`retryCreditTx`'s 503 LOCK_UNAVAILABLE "Nothing was saved") must not claim that - the order WAS
 * saved. Re-code that one failure as 503 ORDER_SAVED_CREDITS_PENDING carrying `orderId`. The client
 * keeps its Idempotency-Key and resubmits; the replay re-runs the idempotent credit sync (create()'s
 * replay exits), so the selection lands exactly once. Any other error propagates untouched.
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
        "The order was saved, but its credit notes are not applied yet. Retry to finish applying them.",
    });
  }
}
