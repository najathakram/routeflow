/**
 * Run-end cash/check reconciliation. `CollectionEntry`/`summarizeCollections`
 * are a DEVICE-LOCAL tally of what THIS device recorded during THIS run
 * session — a per-device echo for immediacy, shown on the settlement screen
 * while the server's own `collectedPayments` aggregate is the source of
 * truth. F05 (spec R6/R8) moved the actual settlement record server-side:
 * `POST /route-runs/:id/settlement` persists it into the run's own
 * `settlementNote`/`settlementVariance` columns — it is no longer appended to
 * `RouteRun.notes` via PATCH. `shouldForceSettlement` below gates on that
 * server truth (OR'd with this device's own signal for query-staleness right
 * after a collection). Pure — no RN import — Jest-testable.
 */
import { roundMoney } from "@routeflow/pricing";

export type CollectedMethod = "CASH" | "CHECK" | "ZELLE" | "CREDIT_CARD" | "ADVANCE" | "OTHER";

export interface CollectionEntry {
  stopId: string;
  method: CollectedMethod;
  /** Already-final, server-accepted collected amount for that stop. */
  amount: number;
  collectedAt: number; // epoch ms
}

export interface SettlementSummary {
  byMethod: Partial<Record<CollectedMethod, number>>;
  /** CASH + CHECK — the physical money a driver must reconcile at end of run. */
  cashTotal: number;
  /** All methods, informational only. */
  total: number;
  count: number;
}

/**
 * Summarize a run's locally-recorded collections. Each entry.amount is
 * already a final, server-accepted number (the same `collected` value
 * payment.tsx sent to completeWithPayment) — this only SUMS already-final
 * amounts for display, it never re-derives a line price.
 */
export function summarizeCollections(entries: CollectionEntry[]): SettlementSummary {
  const byMethod: Partial<Record<CollectedMethod, number>> = {};
  for (const e of entries) {
    byMethod[e.method] = roundMoney((byMethod[e.method] ?? 0) + e.amount);
  }
  const cashTotal = roundMoney((byMethod.CASH ?? 0) + (byMethod.CHECK ?? 0));
  const total = roundMoney(entries.reduce((s, e) => s + e.amount, 0));
  return { byMethod, cashTotal, total, count: entries.length };
}

/** counted - expected, cents-rounded. Positive = over, negative = short. */
export function computeVariance(expectedCash: number, countedCash: number): number {
  return roundMoney(countedCash - expectedCash);
}

/** Matches the acceptance criteria's "±$0.01" tolerance. */
export function isReconciled(variance: number): boolean {
  return Math.abs(variance) <= 0.01;
}

/**
 * Structured line appended to RouteRun.notes — the only persistence
 * primitive available without a new API endpoint (PATCH /route-runs/:id
 * already accepts {notes}, DRIVER-callable for their own run).
 */
export function buildSettlementNote(args: {
  expectedCash: number;
  countedCash: number;
  variance: number;
  overridden: boolean;
  driverLabel: string;
  when?: Date;
}): string {
  const { expectedCash, countedCash, variance, overridden, driverLabel, when = new Date() } = args;
  const status = isReconciled(variance) ? "reconciled" : overridden ? "override" : "variance";
  // Sign goes BEFORE the "$" (e.g. "-$10.00", "+$0.00") — use Math.abs for the
  // number itself rather than relying on toFixed's own embedded minus, which
  // would otherwise render "$-10.00". Zero/reconciled shows "+" (neutral, not
  // a bare unsigned "$0.00").
  const sign = variance < 0 ? "-" : "+";
  const stamp = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
  return (
    `\n[${stamp} – Settlement: expected $${expectedCash.toFixed(2)}, ` +
    `counted $${countedCash.toFixed(2)}, variance ${sign}$${Math.abs(variance).toFixed(2)} ` +
    `(${status}) — ${driverLabel}]`
  );
}

export interface ForceSettlementRun {
  collectedPayments?: { cashTotal: number; checkTotal?: number; count?: number } | null;
  settlementNote?: string | null;
}

/**
 * The server's own expected figure for the settlement screen, on the SAME
 * basis as everything else here: physical money = CASH + CHECK. The API keeps
 * the two split (`getRunCashCollections` → `{ cashTotal, checkTotal }`) for
 * reporting, so a consumer that reads `cashTotal` alone silently drops every
 * check the driver is carrying and manufactures a variance. Returns null when
 * the payload has not loaded yet, so callers can fall back to this device's
 * own tally (`summarizeCollections().cashTotal`, same basis) rather than
 * reconciling against a bogus $0.00.
 */
export function expectedPhysicalCash(
  collected: { cashTotal: number; checkTotal?: number } | null | undefined,
): number | null {
  if (!collected) return null;
  return roundMoney(collected.cashTotal + (collected.checkTotal ?? 0));
}

/**
 * REG-B152 (spec R8): server-truth settlement gate. Forces the end-of-run
 * settlement screen when the run payload shows cash/check actually collected
 * (`collectedPayments.cashTotal + checkTotal > 0`) and no `settlementNote` is
 * on record yet — the server, not this device's local tally, is the truth
 * here. OR'd with `storeSignal` (this device's own "did I collect cash/check
 * this run" signal) to cover the query-staleness window right after a
 * collection, before `collectedPayments` has been refetched — an AND here
 * would strand exactly that case (see the test's fourth call: no
 * `collectedPayments` yet + a true store signal must still force settlement).
 * Either basis is suppressed once `settlementNote` is already on record.
 */
export function shouldForceSettlement(
  run: ForceSettlementRun | null | undefined,
  storeSignal = false,
): boolean {
  const noteMissing = run?.settlementNote == null;
  const serverCashCollected = (expectedPhysicalCash(run?.collectedPayments) ?? 0) > 0;
  return (serverCashCollected && noteMissing) || (storeSignal && noteMissing);
}
