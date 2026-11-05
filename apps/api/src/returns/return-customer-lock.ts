/**
 * SA-1101 A-6 Part 2 (B1279): the ONE definition of the customer-scoped returns advisory lock key.
 *
 * Every transaction that creates or approves a return for a customer (STANDARD create, INLINE capture and approve) takes
 * this lock first, and so does the live-return guard (`lockThenAssertNoLiveReturn`), so a guarded order change for that
 * customer waits for any return in flight and then counts it. The key is `IdempotencyService.hashFor(customerId,
 * tenantId, "returns.customer")` and nothing else: pure (a sha256 of the scope and the id), so it needs no service.
 *
 * `keys` lets a caller that holds the injected `IdempotencyService` keep deriving through it (its specs fake `hashFor`);
 * the default is a plain instance, which has no dependencies. The scope literal lives here and nowhere else
 * (pinned by return-customer-lock.spec.ts).
 */
import { IdempotencyService } from "../common/idempotency.service";

const PURE_KEYS = new IdempotencyService();

export function returnCustomerLockKey(
  customerId: string,
  tenantId: string | null,
  keys: Pick<IdempotencyService, "hashFor"> = PURE_KEYS,
): string {
  return keys.hashFor(customerId, tenantId, "returns.customer");
}

/**
 * Take the returns lock of every customer who owns one of `orderIds`, on `tx`'s own connection (transaction-scoped, so
 * it ends with the transaction). Distinct customers in key order, so two guards over several customers cannot deadlock.
 * Returns the customer ids it locked, for a caller that must re-check an order's customer after its row lock.
 * The caller's FIRST statement, before any row lock (house order: advisory -> Return -> Order -> Invoice, SA-214).
 */
export async function lockReturnCustomersOf(
  tx: {
    $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
    order: { findMany: (args: any) => Promise<{ customerId: string; tenantId: string | null }[]> };
  },
  orderIds: readonly string[],
): Promise<string[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.order.findMany({
    where: { id: { in: [...orderIds] } },
    select: { customerId: true, tenantId: true },
  });
  const byKey = new Map<string, string>();
  for (const row of rows)
    byKey.set(returnCustomerLockKey(row.customerId, row.tenantId), row.customerId);
  for (const key of [...byKey.keys()].sort()) await PURE_KEYS.acquireLock(key, tx);
  return [...byKey.values()];
}
