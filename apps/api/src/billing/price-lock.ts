import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../common/db-locks";

/** How long a price writer waits for another writer of the same tenant's price. */
export const TENANT_PRICE_LOCK_WAIT_MS = 20_000;

/**
 * SA-733 D8: ONE writer per tenant's Stripe price at a time. The price-override flow reads the
 * subscription, pushes to Stripe, writes the row and (on failure) re-syncs Stripe from the committed row;
 * the plan-price fan-out pushes the catalog price for the same tenants. Interleaved, one could overwrite
 * the other's Stripe update and leave Stripe billing a price the database does not hold. This is a
 * Postgres session advisory lock (`tenant-price` family, key = the tenant id; every price-affecting writer takes it), cross-replica safe, held
 * across the Stripe calls. Call it BEFORE any transaction opens. It is NOT an in-process lock.
 *
 * A wait that times out is a retryable 409 CONCURRENT_UPDATE; a lock that cannot be taken at all is a 503
 * LOCK_UNAVAILABLE. In both cases `fn` never ran.
 */
export async function underTenantPriceLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await withAdvisoryLock(
      {
        family: "tenant-price",
        key: tenantId,
        mode: "wait",
        waitMs: TENANT_PRICE_LOCK_WAIT_MS,
      },
      fn,
    );
    if (!result.acquired) {
      // Unreachable under mode "wait"; kept so LockResult narrows.
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.LOCK_UNAVAILABLE,
        message: "The price lock is unavailable. Please retry.",
      });
    }
    return result.value;
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      throw new ConflictException({
        code: API_ERROR_CODES.CONCURRENT_UPDATE,
        message: "Another price change for this tenant is in progress. Please retry.",
      });
    }
    if (e instanceof LockUnavailableError) {
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.LOCK_UNAVAILABLE,
        message: "The price lock is unavailable. Please retry.",
      });
    }
    throw e;
  }
}
