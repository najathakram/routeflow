import * as fs from "fs";
import * as path from "path";

/**
 * SA-767 R6 (SA must 3): the counter-sale void re-takes stock inside its Serializable tx, so it runs through
 * `retryStockTx` (which also retries a lock wait, 55P03, and an expired tx budget, P2028) - not the plain
 * `retryOnTxConflict`, which would surface those as a raw 500. The give-up (a 503 LOCK_UNAVAILABLE) is mapped to
 * the clerk-facing "busy" answer exactly like the other lock timeouts.
 */
describe("counter-sale void retries stock lock waits (SA-767 R6)", () => {
  const src = fs
    .readFileSync(path.join(__dirname, "counter-sale-void.service.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("voidLocked runs its transaction through retryStockTx", () => {
    expect(src).toMatch(/await retryStockTx\(`counter sale void order=\$\{orderId\}`/);
    expect(src).toMatch(
      /import \{ retryStockTx, txConflictState \} from "..\/..\/common\/tx-retry"/,
    );
  });

  it("the plain conflict retry is not used for it", () => {
    expect(src).not.toMatch(/retryOnTxConflict/);
  });

  it("a retryStockTx give-up (503 LOCK_UNAVAILABLE) is answered as 'busy', like a lock timeout", () => {
    expect(src).toMatch(/isStockLockUnavailable\(e\)/);
    expect(src).toMatch(/body\?\.code === API_ERROR_CODES\.LOCK_UNAVAILABLE/);
  });
});
