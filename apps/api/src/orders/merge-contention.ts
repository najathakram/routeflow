/**
 * INVARIANT (PR-2, imp-02) — where a merge-lock failure may surface as an error, and where it
 * may NOT.
 *
 * `MERGE_IN_PROGRESS` (409) and the lock-unavailable 503 are raised ONLY before any write in the
 * request — from the critical section's OWN lock acquisition. Every consolidation that runs AFTER
 * a row has committed (the staff post-merge sweep, the post-create auto-consolidation, an order
 * created from a standing-order template, the buyer portal's sibling sweep) treats lock contention
 * as "deferred": it logs a warning and returns the already-committed result.
 *
 * So: a client that receives 409 can always retry safely — nothing folded — and a client NEVER
 * receives an error for an order that already exists. That asymmetry is the whole point. The
 * merge folds compute ABSOLUTE totals, so answering a committed write with a retryable 409 would
 * make the retry fold the same cart in a second time and inflate the order.
 *
 * Those post-commit callers additionally ask for the lock with `{ lockMode: "try" }`, so a held
 * lock is reported immediately (`{ acquired: false }` → the same coded 503) instead of after a
 * 20 s wait. That 503 is raised INSIDE the request and swallowed here as "deferred" — it never
 * reaches a client, which is why it does not violate the invariant above.
 *
 * `mapLockError` is the ONE place a `db-locks` failure becomes an HTTP error; `isMergeContention`
 * is the ONE place a caller recognises that error again — by CODE, never by exception type. A
 * plain 409/503 raised anywhere else in the merge path (a credit-limit conflict, say) is NOT
 * contention and must keep propagating.
 */

import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { LockTimeoutError, LockUnavailableError } from "../common/db-locks";
import { API_ERROR_CODES } from "../common/api-error-codes";

/** Response `code` of the 409 raised when a customer's merge lock is already held. */
export const MERGE_IN_PROGRESS = API_ERROR_CODES.MERGE_IN_PROGRESS;
/** Response `code` of the 503 raised when no lock connection could be obtained at all. */
export const LOCK_UNAVAILABLE = API_ERROR_CODES.LOCK_UNAVAILABLE;

export const MERGE_IN_PROGRESS_MESSAGE = "Another merge for this customer is in progress — retry.";
export const LOCK_UNAVAILABLE_MESSAGE = "Order merge lock unavailable — retry shortly.";

/**
 * The `code` of an HttpException whose response body is an object. A string body (the
 * `new ConflictException("some text")` form) carries no code and yields `undefined`, so it can
 * never be mistaken for contention.
 */
function responseCode(e: ConflictException | ServiceUnavailableException): unknown {
  const body = e.getResponse();
  return typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
}

/** True only for the two lock-contention errors `mapLockError` produces — by code, not by type. */
export function isMergeContention(e: unknown): boolean {
  if (e instanceof ConflictException) return responseCode(e) === MERGE_IN_PROGRESS;
  if (e instanceof ServiceUnavailableException) return responseCode(e) === LOCK_UNAVAILABLE;
  return false;
}

/** The coded 409 (`isMergeContention` recognises it by code): nothing was written, retry is safe. */
export function mergeInProgress(): ConflictException {
  return new ConflictException({ code: MERGE_IN_PROGRESS, message: MERGE_IN_PROGRESS_MESSAGE });
}

/**
 * A raw 55P03 (the write-phase `lock_timeout` backstop), 40P01 (deadlock against a lock-free writer such
 * as deleteOrder) or 40001 (serialization failure) raised inside the merge tx is contention too: nothing
 * was folded, retry is safe.
 */
export function isRawLockTimeout(e: unknown): boolean {
  return (
    ["55P03", "40P01", "40001"].some(
      (c) => (e as any)?.meta?.code === c || (e as any)?.code === c,
    ) ||
    /lock timeout|could not obtain lock|deadlock detected|could not serialize/i.test(
      String((e as any)?.message ?? ""),
    )
  );
}

/**
 * The single mapping from a `db-locks` failure to its wire contract: 55P03 (`LockTimeoutError`)
 * → retryable 409, no lock connection (`LockUnavailableError`) → 503, anything else rethrown
 * untouched. Both bodies are objects so `isMergeContention` can recognise them downstream.
 */
export function mapLockError(e: unknown): never {
  if (e instanceof LockTimeoutError) {
    throw new ConflictException({ code: MERGE_IN_PROGRESS, message: MERGE_IN_PROGRESS_MESSAGE });
  }
  if (e instanceof LockUnavailableError) {
    throw new ServiceUnavailableException({
      code: LOCK_UNAVAILABLE,
      message: LOCK_UNAVAILABLE_MESSAGE,
    });
  }
  // B1053: the merge tx's write-phase `lock_timeout` (55P03) is the same "someone else is writing".
  if (isRawLockTimeout(e)) throw mergeInProgress();
  throw e;
}

/**
 * `withAdvisoryLock`'s "someone else holds this customer's lock" outcome as the coded 503 the sweep and every
 * post-commit caller recognise (`isMergeContention`). Moved verbatim out of the two merge methods that each
 * carried the same `if (!result.acquired) throw …` block inline.
 */
export function assertMergeLockAcquired<T extends { acquired: boolean }>(
  result: T,
): asserts result is Extract<T, { acquired: true }> {
  if (!result.acquired) {
    throw new ServiceUnavailableException({
      code: LOCK_UNAVAILABLE,
      message: LOCK_UNAVAILABLE_MESSAGE,
    });
  }
}
