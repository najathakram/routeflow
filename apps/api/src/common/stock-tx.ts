import { STOCK_TX_OPTIONS, setStockLockTimeout } from "./product-locks";
import { retryStockTx } from "./tx-retry";

/**
 * SA-767: THE shape of a stock-writing transaction outside InventoryService - `retryStockTx` around
 * `tenantTransaction`, with the lock-wait bound set as the tx's FIRST statement (so a domain-row lock taken
 * before the Product rows - the Order row of an edit, a template, a customer - is bounded too) and a budget
 * that lets the 5 s lock timeout fire before Prisma's own interactive-tx timeout (P2028). A caller's own
 * `timeout` / isolation level wins; the budget is passed on so a long one is not retried on expiry.
 */
export function stockTxBounded<T>(
  prisma: { tenantTransaction(fn: (tx: any) => Promise<any>, opts?: any): Promise<any> },
  label: string,
  fn: (tx: any) => Promise<T>,
  opts?: { timeout?: number; [k: string]: unknown },
): Promise<T> {
  const txOpts = { ...STOCK_TX_OPTIONS, ...opts };
  return retryStockTx<T>(
    label,
    () =>
      prisma.tenantTransaction(async (tx) => {
        await setStockLockTimeout(tx);
        return fn(tx);
      }, txOpts) as Promise<T>,
    { budgetMs: txOpts.timeout },
  );
}
