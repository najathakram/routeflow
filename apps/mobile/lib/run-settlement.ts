/**
 * Run-end cash/check reconciliation. No backend model exists for this (see
 * plan §2.3) — this is a DEVICE-LOCAL tally of what THIS device recorded
 * during THIS run session, persisted only as an appended note on the run via
 * the existing PATCH /route-runs/:id (notes) — same append pattern
 * orders.service.ts already uses for its own edit-revert note. Pure — no RN
 * import — Jest-testable.
 */
import { roundMoney } from "./pricing";

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
