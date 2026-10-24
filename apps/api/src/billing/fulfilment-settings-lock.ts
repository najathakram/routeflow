import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../common/db-locks";

/** The two tenant config keys whose writers serialise on the `fulfilment-settings` lock. */
export const FULFILMENT_LOCKED_KEYS: readonly string[] = ["fulfilment_model", "counter_sales"];

/** How long a writer waits for another writer of the same tenant before giving up with a 409. */
export const FULFILMENT_LOCK_WAIT_MS = 10_000;

export const isFulfilmentLockedKey = (key: string): boolean => FULFILMENT_LOCKED_KEYS.includes(key);

/**
 * Runs `fn` under the per-tenant `fulfilment-settings` advisory lock (M2). Every writer of
 * `fulfilment_model` / `counter_sales` that reads-then-writes (the tenant Settings PATCH, the Feature
 * Console `set()` / `clear()`, a business-profile apply through `set()`) goes through here, so a
 * fingerprint check and its write cannot interleave with another writer.
 *
 * Call it BEFORE any transaction opens: the lock lives on its own pooled connection and a held lock
 * under an open transaction would invert the order. Snapshot restore is the one deliberate
 * exception (it stays outside the lock; last writer wins).
 *
 * A wait that times out is a retryable 409 CONCURRENT_UPDATE; a lock that cannot be taken at all
 * (pool or connection trouble) is a 503 LOCK_UNAVAILABLE. In both cases `fn` never ran.
 */
export async function underFulfilmentLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await withAdvisoryLock(
      {
        family: "fulfilment-settings",
        key: tenantId,
        mode: "wait",
        waitMs: FULFILMENT_LOCK_WAIT_MS,
      },
      fn,
    );
    if (!result.acquired) {
      // Unreachable under mode "wait"; kept so LockResult narrows.
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.LOCK_UNAVAILABLE,
        message: "The settings lock is unavailable. Please retry.",
      });
    }
    return result.value;
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      throw new ConflictException({
        code: API_ERROR_CODES.CONCURRENT_UPDATE,
        message: "Another change to these settings is in progress. Please retry.",
      });
    }
    if (e instanceof LockUnavailableError) {
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.LOCK_UNAVAILABLE,
        message: "The settings lock is unavailable. Please retry.",
      });
    }
    throw e;
  }
}
