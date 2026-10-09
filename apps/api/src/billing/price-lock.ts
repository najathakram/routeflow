import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../common/db-locks";

/** The one advisory-lock family every writer of a tenant's Stripe price takes (key = the tenant id). */
export const TENANT_PRICE_LOCK_FAMILY = "tenant-price";

/** How long an admin / cron price writer waits for another writer of the same tenant's price. */
export const TENANT_PRICE_LOCK_WAIT_MS = 20_000;

/**
 * How long a TENANT-FACING writer (the in-app upgrade) waits. Short on purpose: the lock is held across Stripe
 * calls, the `tenant-price` pool is small, and a double-click burst must fail fast with a retryable 409 rather
 * than pin the pool for the long admin wait.
 */
export const TENANT_PRICE_LOCK_SELF_SERVE_WAIT_MS = 2_500;

const ADMIN_BUSY = "Another price change for this tenant is in progress. Please retry.";
const UNAVAILABLE = "The price lock is unavailable. Please retry.";

export interface PriceLockOptions {
  /** Wait budget in ms (default {@link TENANT_PRICE_LOCK_WAIT_MS}). */
  waitMs?: number;
  /** The 409 copy when the wait times out (default: the admin copy). Tenant-facing callers pass safe copy. */
  busyMessage?: string;
}

/**
 * SA-733 D8: ONE writer per tenant's Stripe price at a time. The price-override flow reads the subscription,
 * pushes to Stripe, writes the row and (on failure) re-syncs Stripe from the committed row; the plan-price
 * fan-out, the in-app upgrade, the admin plan edit and the scheduled-downgrade sweep push for the same tenants.
 * Interleaved, one could overwrite the other's Stripe update and leave Stripe billing a price the database does
 * not hold. This is a Postgres session advisory lock (`tenant-price` family), cross-replica safe, held across
 * the Stripe calls. Call it BEFORE any transaction opens and BEFORE reading the inputs the writer will price
 * from. It is NOT an in-process lock.
 *
 * ONE timeout mapping for every caller: a wait that times out is a retryable 409 CONCURRENT_UPDATE; a lock that
 * cannot be taken at all is a 503 LOCK_UNAVAILABLE. In both cases `fn` never ran.
 */
export async function underTenantPriceLock<T>(
  tenantId: string,
  fn: () => Promise<T>,
  opts: PriceLockOptions = {},
): Promise<T> {
  try {
    const result = await withAdvisoryLock(
      {
        family: TENANT_PRICE_LOCK_FAMILY,
        key: tenantId,
        mode: "wait",
        waitMs: opts.waitMs ?? TENANT_PRICE_LOCK_WAIT_MS,
      },
      fn,
    );
    if (!result.acquired) throw unavailable(); // unreachable under mode "wait"; narrows LockResult
    return result.value;
  } catch (e) {
    throw mapLockError(e, opts);
  }
}

/**
 * The same lock as an explicit acquire / release pair, for a caller whose critical section is a long loop body
 * it cannot re-indent into a callback (the scheduled-downgrade sweep). Always `await release()` in a `finally`.
 */
export async function lockTenantPrice(
  tenantId: string,
  opts: PriceLockOptions = {},
): Promise<() => Promise<void>> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let onAcquired!: () => void;
  let onFailed!: (e: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    onAcquired = resolve;
    onFailed = reject;
  });
  const done = withAdvisoryLock(
    {
      family: TENANT_PRICE_LOCK_FAMILY,
      key: tenantId,
      mode: "wait",
      waitMs: opts.waitMs ?? TENANT_PRICE_LOCK_WAIT_MS,
    },
    () => {
      onAcquired();
      return held;
    },
  ).then(
    () => undefined,
    (e) => onFailed(mapLockError(e, opts)), // a rejection after `fn` ran (a failed unlock) is already settled: a no-op
  );
  await acquired;
  return async () => {
    release();
    await done;
  };
}

const unavailable = () =>
  new ServiceUnavailableException({ code: API_ERROR_CODES.LOCK_UNAVAILABLE, message: UNAVAILABLE });

function mapLockError(e: unknown, opts: PriceLockOptions): unknown {
  if (e instanceof LockTimeoutError) {
    return new ConflictException({
      code: API_ERROR_CODES.CONCURRENT_UPDATE,
      message: opts.busyMessage ?? ADMIN_BUSY,
    });
  }
  if (e instanceof LockUnavailableError) return unavailable();
  return e;
}
