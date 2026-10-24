import { STOCK_TX_OPTIONS, setStockLockTimeout } from "./product-locks";
import { retryStockTx } from "./tx-retry";

type TxPrisma = { tenantTransaction(fn: (tx: any) => Promise<any>, opts?: any): Promise<any> };
type TxOpts = { timeout?: number; [k: string]: unknown };

/**
 * SA-855: THE lock-wait bound of an interactive transaction - `tenantTransaction` with `setStockLockTimeout` as its
 * FIRST statement (so every lock it takes, a domain row or an advisory code lock, waits at most STOCK_LOCK_TIMEOUT) and
 * a budget that lets that 5 s lock timeout fire (55P03) before Prisma's own interactive-tx timeout (P2028). A single
 * attempt: a lock that timed out propagates, and the global LockConflictFilter answers it as the coded retryable 503.
 * A caller's own `timeout` / isolation level wins.
 */
export function boundedTenantTx<T>(
  prisma: TxPrisma,
  fn: (tx: any) => Promise<T>,
  opts?: TxOpts,
): Promise<T> {
  return prisma.tenantTransaction(
    async (tx) => {
      await setStockLockTimeout(tx);
      return fn(tx);
    },
    { ...STOCK_TX_OPTIONS, ...opts },
  ) as Promise<T>;
}

/**
 * SA-767: THE shape of a stock-writing transaction outside InventoryService - `retryStockTx` around the bounded
 * transaction (`boundedTenantTx`, SA-855), so a domain-row lock taken before the Product rows - the Order row of an
 * edit, a template, a customer - is bounded too. The budget is passed on so a long one is not retried on expiry.
 */
export function stockTxBounded<T>(
  prisma: TxPrisma,
  label: string,
  fn: (tx: any) => Promise<T>,
  opts?: TxOpts,
): Promise<T> {
  const txOpts = { ...STOCK_TX_OPTIONS, ...opts };
  return retryStockTx<T>(label, () => boundedTenantTx(prisma, fn, opts), {
    budgetMs: txOpts.timeout,
  });
}
