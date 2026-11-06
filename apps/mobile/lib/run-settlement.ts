/**
 * Run-end cash/check reconciliation. `CollectionEntry`/`summarizeCollections`
 * are a DEVICE-LOCAL tally of what THIS device recorded during THIS run
 * session — a per-device echo for immediacy, shown on the settlement screen
 * while the server's own `collectedPayments` aggregate is the source of
 * truth. F05 (spec R6/R8) moved the actual settlement record server-side:
 * `POST /route-runs/:id/settlement` persists it into the run's own
 * `settlementNote`/`settlementVariance` columns — it is no longer appended to
 * `RouteRun.notes` via PATCH. `shouldForceSettlement` (re-exported from
 * `@routeflow/pricing` at the foot of this file) gates on that server truth.
 * Pure — no RN import — Jest-testable.
 */
import {
  computeVariance,
  expectedPhysicalCash,
  isReconciled,
  roundMoney,
  shouldForceSettlement,
} from "@routeflow/pricing";
import type { ForceSettlementRun } from "@routeflow/pricing";
import type { PaymentMethod } from "@routeflow/types";

// #2722: the methods a driver can collect on a run, in display order — a subset of the shared
// PaymentMethod (a typo is a compile error).
export const COLLECTED_METHODS = [
  "CASH",
  "CHECK",
  "ZELLE",
  "CREDIT_CARD",
  "ADVANCE",
  "OTHER",
] as const satisfies readonly PaymentMethod[];
export type CollectedMethod = (typeof COLLECTED_METHODS)[number];

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

export interface SettlementRow {
  method: CollectedMethod;
  amount: number;
  /**
   * "server": the run's own `collectedPayments` aggregate, the SAME source as the total the driver
   * reconciles against. "device": this device's tally (the offline fallback, or a method the server
   * aggregate does not cover).
   */
  basis: "server" | "device";
}

export interface SettlementRows {
  /** The reconciliation table: CASH and CHECK only, the physical money the total is made of. */
  rows: SettlementRow[];
  /** Methods the server total does not cover (card, Zelle, advance, other): info only, this device's tally. */
  deviceOnly: SettlementRow[];
  /** True once the run's `collectedPayments` has loaded; until then every figure is this device's tally. */
  serverLoaded: boolean;
}

/**
 * B1008 (SA-644): the settlement screen's rows. CASH and CHECK come from the server's
 * `collectedPayments` whenever it has loaded, so they always sum to `expectedPhysicalCash` (the total
 * shown beside them) and cannot disagree after a sign-out, a reinstall, a second device or an offline
 * payment the server has not seen yet. Before the payload loads they fall back to this device's tally
 * (basis "device", `serverLoaded` false, and the screen disables closing). Card, Zelle, advance and
 * other are NOT part of the cash settlement: they are returned separately, from this device, for an
 * info list. Pure: it only picks between already-final amounts, it never re-derives one.
 */
export function buildSettlementRows(
  collected: { cashTotal: number; checkTotal?: number; count?: number } | null | undefined,
  entries: CollectionEntry[],
): SettlementRows {
  const local = summarizeCollections(entries).byMethod;
  const rows: SettlementRow[] = [];
  const deviceOnly: SettlementRow[] = [];
  for (const method of COLLECTED_METHODS) {
    const physical = method === "CASH" || method === "CHECK";
    let amount = local[method] ?? 0;
    let basis: SettlementRow["basis"] = "device";
    if (collected && method === "CASH") {
      amount = collected.cashTotal;
      basis = "server";
    } else if (collected && method === "CHECK") {
      amount = collected.checkTotal ?? 0;
      basis = "server";
    }
    if (!amount) continue;
    (physical ? rows : deviceOnly).push({ method, amount: roundMoney(amount), basis });
  }
  return { rows, deviceOnly, serverLoaded: expectedPhysicalCash(collected) != null };
}

/**
 * SA-644a: the settlement totals count as ready only when the run payload is present AND this screen's
 * own fetch has completed (react-query `isFetchedAfterMount`). A cache hit from an earlier visit is data
 * the server may since have moved on from, so it never unlocks closing the run on its own.
 */
export function settlementTotalsReady(args: {
  serverLoaded: boolean;
  fetchedAfterMount: boolean;
}): boolean {
  return args.serverLoaded && args.fetchedAfterMount;
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

// SA-1098 A-1 (PR-S): these four moved to @routeflow/pricing so the web run page and the API share
// them. Re-exported so no native screen or spec changes.
export { computeVariance, expectedPhysicalCash, isReconciled, shouldForceSettlement };
export type { ForceSettlementRun };
