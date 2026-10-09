import { ServiceUnavailableException } from "@nestjs/common";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../common/db-locks";

/**
 * SA-733 D8: every writer that moves a tenant's Stripe price serialises per tenant on ONE advisory lock —
 * `{ family: "tenant-price", key: <tenantId> }`, the same family and key the price-override branch and the
 * catalog fan-out take. The in-app upgrade, the admin plan edit and the scheduled-downgrade sweep join it, so a
 * double-clicked upgrade (or an override committing mid-upgrade) can never make a losing attempt's
 * compensating revert restore a STALE price over the winner's. The lock is outermost: it is taken before the
 * attempt reads its preconditions, so a second attempt sees the first one's result ("not an upgrade").
 */
export const TENANT_PRICE_LOCK_FAMILY = "tenant-price";

/** Fixed tenant-facing copy for a lock that could not be taken in time. */
export const TENANT_PRICE_LOCK_BUSY =
  "Another billing change for this account is still in progress. Please wait a moment, then check the plan.";

const busy = (e: unknown): unknown =>
  e instanceof LockTimeoutError || e instanceof LockUnavailableError
    ? new ServiceUnavailableException(TENANT_PRICE_LOCK_BUSY)
    : e;

/** Run `fn` holding the tenant's price lock (wait mode). A lock that cannot be taken is a 503. */
export async function withTenantPriceLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await withAdvisoryLock(
      { family: TENANT_PRICE_LOCK_FAMILY, key: tenantId, mode: "wait" },
      fn,
    );
    if (!r.acquired) throw new ServiceUnavailableException(TENANT_PRICE_LOCK_BUSY);
    return r.value;
  } catch (e) {
    throw busy(e);
  }
}

/**
 * The same lock as an explicit acquire / release pair, for a caller whose critical section is a long loop body
 * it cannot re-indent into a callback (the scheduled-downgrade sweep). Always `await release()` in a `finally`.
 */
export async function lockTenantPrice(tenantId: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let onAcquired!: () => void;
  let onFailed!: (e: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    onAcquired = resolve;
    onFailed = reject;
  });
  const done = withAdvisoryLock(
    { family: TENANT_PRICE_LOCK_FAMILY, key: tenantId, mode: "wait" },
    () => {
      onAcquired();
      return held;
    },
  ).then(
    () => undefined,
    (e) => onFailed(busy(e)), // a rejection after `fn` ran (a failed unlock) is already settled: a no-op
  );
  await acquired;
  return async () => {
    release();
    await done;
  };
}
