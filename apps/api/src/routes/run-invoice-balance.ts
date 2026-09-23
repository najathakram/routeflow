/**
 * B810: the run read (findAllRuns/findOneRun/findMyRuns's 4 RUN_STOP_INCLUDE-
 * derived call sites, routes.service.ts) projects a PAYABLE invoice list per
 * order alongside each invoice's server-computed `balanceDue` (B421's exact
 * formula: total - confirmed payments, clamped at 0). The raw `payments` rows
 * are fetched only to compute this and are NEVER returned to the client —
 * B305's standing rule (no client total-minus-payments) plus a tighter
 * boundary (no raw payment data need reach a driver's device for a number).
 * SA-125: ONE mapper here, applied at all 4 call sites, so they can't drift.
 */
import { PAYABLE } from "../invoices/invoice-status-sets";
import { sumConfirmed } from "../invoices/payment-predicates";
import { roundMoney } from "@routeflow/pricing";

/**
 * Mirrors recordDeliveryPaymentInTx's own query for the driver's actual
 * payment write path (invoices.service.ts) EXACTLY: PAYABLE statuses
 * (DRAFT/SENT/PARTIAL/OVERDUE), oldest-first, NO deliveryBatchId gate — a
 * batch-tagged SENT invoice IS still paid off by the door close, so it must
 * be counted (unlike `invoices` above, the DRAFT-only reconcile basis, which
 * stays byte-identical and untouched — this is a SEPARATE list, never a
 * widened one).
 */
export const RUN_PAYABLE_INVOICE_SELECT = {
  where: { status: { in: PAYABLE } },
  orderBy: [{ createdAt: "asc" as const }, { invoiceNumber: "asc" as const }],
  select: {
    id: true,
    status: true,
    total: true,
    payments: { select: { amount: true, status: true } },
  },
} as const;

interface RawPayableInvoice {
  id: string;
  status: string;
  total: number | string | null;
  payments: { amount: number | string; status: string }[];
}

export interface RunPayableInvoice {
  id: string;
  status: string;
  /** Server-computed remaining balance — never a client total-minus-payments. */
  balanceDue: number;
}

/**
 * total - Σ confirmed payments (via the shared `sumConfirmed`, never a
 * hand-rolled reduce), clamped at 0. Uniform across every status — a DRAFT
 * with a confirmed payment (e.g. an applied advance) nets down too, never a
 * per-status assumption. Strips the raw `payments` rows.
 */
export function withBalanceDue(invoices: RawPayableInvoice[]): RunPayableInvoice[] {
  return invoices.map((inv) => ({
    id: inv.id,
    status: inv.status,
    balanceDue: roundMoney(Math.max(0, Number(inv.total) - sumConfirmed(inv.payments))),
  }));
}

/**
 * Applies `withBalanceDue` to every order's `payableInvoices` within a stops
 * array — the shape run-money.ts (mobile) reads. Call this exactly once, right
 * before a RUN_STOP_INCLUDE-derived response leaves the service (findAllRuns,
 * findOneRun's two internal queries, findMyRuns — SA-125's "one mapper, four
 * call sites"). Loosely typed to match this file's existing `any`-shaped
 * routes.service.ts callers rather than fighting a huge Prisma result type.
 */
export function withRunOrderBalances<T extends { orders?: any[] }>(stops: T[]): T[] {
  return stops.map((s: any) => ({
    ...s,
    orders: (s.orders ?? []).map((o: any) => ({
      ...o,
      payableInvoices: withBalanceDue(o.payableInvoices ?? []),
    })),
  }));
}
