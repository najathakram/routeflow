/**
 * Run-end cash/check reconciliation figures (SA-1098 A-1, PR-S). Moved here from the native app's
 * `lib/run-settlement.ts` so the API, the web run page and the native screen share one answer to
 * "what does the driver owe, and does this count need a reason". Pure, no framework import.
 *
 * The server still computes the expected figure itself (`getRunCashCollections`) and a client's
 * total is never trusted; these helpers only read what the server sent and mirror its rule.
 */
import { roundMoney } from "./pricing";

/**
 * The largest count a settlement takes: $10,000,000. `RouteRun.settlementVariance` is DECIMAL(10,2), so a bigger
 * figure overflowed the column into an uncoded 500. The web form never sends past it; the server refuses it with
 * `RUN_COUNT_TOO_LARGE` (review-b on #4188).
 */
export const SETTLE_MAX_COUNT = 10_000_000;

export interface ForceSettlementRun {
  collectedPayments?: { cashTotal: number; checkTotal?: number; count?: number } | null;
  settlementNote?: string | null;
}

/**
 * The server's own expected figure for the settlement screen: physical money = CASH + CHECK. The API
 * keeps the two split (`getRunCashCollections` → `{ cashTotal, checkTotal }`) for reporting, so a
 * consumer that reads `cashTotal` alone silently drops every check and manufactures a variance.
 * Returns null when the payload has not loaded yet, so a caller never reconciles against a bogus $0.00.
 */
export function expectedPhysicalCash(
  collected: { cashTotal: number; checkTotal?: number } | null | undefined,
): number | null {
  if (!collected) return null;
  return roundMoney(collected.cashTotal + (collected.checkTotal ?? 0));
}

/** counted - expected, cents-rounded. Positive = over, negative = short. */
export function computeVariance(expectedCash: number, countedCash: number): number {
  return roundMoney(countedCash - expectedCash);
}

/** The "±$0.01" tolerance: a variance this small is a reconciled run. */
export function isReconciled(variance: number): boolean {
  return Math.abs(variance) <= 0.01;
}

/**
 * Does this count need a written reason? True when it differs from expected by more than a cent.
 * `settleRun` calls this too, so the server and the screens cannot disagree at the boundary (SE-3).
 */
export function varianceNeedsReason(expectedCash: number, countedCash: number): boolean {
  return !isReconciled(computeVariance(expectedCash, countedCash));
}

/**
 * REG-B152 (spec R8): server-truth settlement gate. Forces the end-of-run settlement when the run
 * payload shows cash/check actually collected (`cashTotal + checkTotal > 0`) and no `settlementNote`
 * is on record yet. OR'd with `storeSignal` (this device's own "did I collect cash/check this run"
 * signal) to cover the query-staleness window right after a collection, before `collectedPayments`
 * has been refetched. Either basis is suppressed once `settlementNote` is already on record.
 */
export function shouldForceSettlement(
  run: ForceSettlementRun | null | undefined,
  storeSignal = false,
): boolean {
  const noteMissing = run?.settlementNote == null;
  const serverCashCollected = (expectedPhysicalCash(run?.collectedPayments) ?? 0) > 0;
  return (serverCashCollected && noteMissing) || (storeSignal && noteMissing);
}
