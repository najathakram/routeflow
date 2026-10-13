/**
 * B810 / SA-130a: the run read (findAllRuns/findOneRun/findMyRuns's 4
 * RUN_STOP_INCLUDE-derived call sites, routes.service.ts) projects a PAYABLE
 * invoice list per order alongside each invoice's server-computed
 * `balanceDue` (B421's exact formula: total - confirmed payments, clamped at
 * 0, uniform across every status including DRAFT — B822). The raw `payments`
 * rows are fetched only to compute this and are NEVER returned to the client
 * — B305's standing rule (no client total-minus-payments) plus a tighter
 * boundary (no raw payment data need reach a driver's device for a number).
 *
 * SA-130a (Opus round, superseding SA-125's original shape): `Order` has NO
 * `payableInvoices` relation — only `invoices` — so this can NEVER be a
 * Prisma `select`/`include` nested under `orders.select` (that throws
 * `Unknown field 'payableInvoices'` against the real client; mocked-Prisma
 * specs hid it because they never validate a `select` shape against the
 * actual generated types). Instead this is a SEPARATE, batched
 * `invoice.findMany` call over every order id at the stop(s) being read, run
 * once per response, whose result is grouped by orderId and attached — ONE
 * mapper, four call sites, so they can't drift.
 *
 * Also computes `isDepositMirror` (SA-102's WP-D1 shape, mirroring
 * `reconcileOrderDraftInvoice`'s own detection in invoices.service.ts
 * exactly): true when an invoice is the order's SOLE non-void invoice, has
 * no `deliveryBatchId`, carries a deposit (`depositPercent != null`), and is
 * in a status a deposit mirror can realistically be in (SENT/VIEWED/
 * PARTIAL/OVERDUE). Mobile needs this to know a payable invoice IS the
 * order's own bill (so a short-pick may legitimately restate it) versus a
 * plain, already-finalized invoice (which a later short-pick must never
 * re-derive — see run-money.ts#reconciledDoorDue for the full three-way rule
 * this field feeds).
 */
import { InvoiceStatus } from "@prisma/client";
import { PAYABLE } from "../invoices/invoice-status-sets";
import { CONFIRMED_PAYMENT } from "../invoices/payment-predicates";
import { confirmedBalance } from "../invoices/invoice-balance-classify";
import { roundMoney } from "@routeflow/pricing";

const PAYABLE_SET = new Set<string>(PAYABLE);

/** Mirrors invoices.service.ts's own DEPOSIT_MIRROR_STATUSES exactly (reconcileOrderDraftInvoice). */
const DEPOSIT_MIRROR_STATUSES = new Set<string>([
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.OVERDUE,
]);

/**
 * Args for the batched per-run invoice read. Fetches every NON-VOID invoice
 * (not just PAYABLE) because `isDepositMirror` needs the order's full
 * non-void count to know it's looking at the SOLE one — the PAYABLE subset
 * is filtered out afterward in `groupPayableInvoicesByOrder`. Oldest-first,
 * matching `recordDeliveryPaymentInTx`'s own ordering.
 */
export function payableInvoiceFindManyArgs(orderIds: string[]) {
  return {
    where: { orderId: { in: orderIds }, status: { not: InvoiceStatus.VOID } },
    orderBy: [{ createdAt: "asc" as const }, { invoiceNumber: "asc" as const }],
    select: {
      id: true,
      orderId: true,
      status: true,
      total: true,
      depositPercent: true,
      deliveryBatchId: true,
      payments: { where: CONFIRMED_PAYMENT, select: { amount: true, status: true } },
    },
  };
}

export interface RawInvoiceForBalance {
  id: string;
  orderId: string | null;
  status: string;
  // `unknown` (not `number | string`) so a real Prisma row's `total`/
  // `depositPercent: Decimal` are assignable without importing Prisma's
  // Decimal type here — same convention as `@routeflow/pricing`'s
  // `ConfirmablePaymentRow.amount` (payment-confirmation.ts). `Number(...)`
  // accepts it the same way every money-summing site already does.
  total: unknown;
  depositPercent: unknown;
  deliveryBatchId: string | null;
  payments: { amount: unknown; status: string }[];
}

export interface RunPayableInvoice {
  id: string;
  status: string;
  total: number;
  /** Server-computed remaining balance — never a client total-minus-payments. */
  balanceDue: number;
  /** SA-102's WP-D1 shape — see the module doc above. */
  isDepositMirror: boolean;
  // `deliveryBatchId` (fetched above for `isDepositMirror`'s detection) is
  // deliberately NOT carried to this output shape: `payableInvoiceFindManyArgs`
  // never gates on it (mirrors recordDeliveryPaymentInTx's own PAYABLE query
  // exactly, SA-130a), so it plays no role in which invoices are included or
  // in `balanceDue`'s formula — a batch-tagged SENT invoice is summed and
  // collected identically to a non-batch one. Nothing downstream (mobile's
  // run-money.ts) branches on it, so exposing it would be dead weight on the
  // wire, not a correctness gap.
}

/**
 * Groups the batched non-void rows by orderId, computes `isDepositMirror`
 * from the FULL non-void set per order, then filters each group down to the
 * PAYABLE subset and computes `balanceDue` (uniform across every status —
 * B822). Never returns raw `payments`.
 */
export function groupPayableInvoicesByOrder(
  rows: RawInvoiceForBalance[],
): Record<string, RunPayableInvoice[]> {
  const byOrder = new Map<string, RawInvoiceForBalance[]>();
  for (const r of rows) {
    if (!r.orderId) continue;
    const list = byOrder.get(r.orderId);
    if (list) list.push(r);
    else byOrder.set(r.orderId, [r]);
  }
  const result: Record<string, RunPayableInvoice[]> = {};
  for (const [orderId, nonVoid] of byOrder) {
    const sole = nonVoid.length === 1 ? nonVoid[0] : null;
    const isSoleDepositMirror =
      sole != null &&
      sole.deliveryBatchId == null &&
      sole.depositPercent != null &&
      DEPOSIT_MIRROR_STATUSES.has(sole.status);
    result[orderId] = nonVoid
      .filter((inv) => PAYABLE_SET.has(inv.status))
      .map((inv) => ({
        id: inv.id,
        status: inv.status,
        total: roundMoney(Number(inv.total)),
        balanceDue: confirmedBalance(inv.total, inv.payments),
        isDepositMirror: isSoleDepositMirror,
      }));
  }
  return result;
}

/**
 * Attaches each order's `payableInvoices` (from `groupPayableInvoicesByOrder`)
 * onto a stops array — the shape mobile's run-money.ts reads. Call this
 * exactly once per read, right after the batched invoice fetch, before a
 * RUN_STOP_INCLUDE-derived response leaves the service (findAllRuns,
 * findOneRun's two internal builds, findMyRuns — SA-125/SA-130a's "one
 * mapper, four call sites").
 */
export function attachPayableInvoices<
  TOrder extends { id: string },
  TStop extends { orders?: TOrder[] | null },
>(stops: TStop[], byOrder: Record<string, RunPayableInvoice[]>) {
  return stops.map((s) => ({
    ...s,
    orders: (s.orders ?? []).map((o) => ({
      ...o,
      payableInvoices: byOrder[o.id] ?? [],
    })),
  }));
}

/** Structural contract for the one Prisma call this needs — never the whole client. */
export interface InvoiceFindManyClient {
  invoice: {
    findMany(args: ReturnType<typeof payableInvoiceFindManyArgs>): Promise<RawInvoiceForBalance[]>;
  };
}

/**
 * The full per-read orchestration — collects every order id across the given
 * stops, runs ONE batched `invoice.findMany`, groups, and attaches. This is
 * the single call each of routes.service.ts's 4 read sites should make; none
 * of them should call `payableInvoiceFindManyArgs`/`groupPayableInvoicesByOrder`/
 * `attachPayableInvoices` directly (that's how the 4 sites would drift).
 */
export async function withPayableInvoices<
  TOrder extends { id: string },
  TStop extends { orders?: TOrder[] | null },
>(db: InvoiceFindManyClient, stops: TStop[]) {
  const orderIds = Array.from(new Set(stops.flatMap((s) => (s.orders ?? []).map((o) => o.id))));
  if (orderIds.length === 0) return attachPayableInvoices(stops, {});
  const rows = await db.invoice.findMany(payableInvoiceFindManyArgs(orderIds));
  return attachPayableInvoices(stops, groupPayableInvoicesByOrder(rows));
}

/**
 * `withPayableInvoices`'s page-of-runs variant (findAllRuns/findMyRuns — call
 * sites 1 and 4 of 4): ONE batched invoice.findMany across EVERY run's stops
 * on the page (never per-run), then re-chunked back onto each run in order.
 * Extracted here (not left as the read-site's own cursor-slicing loop) to
 * keep routes.service.ts's per-call-site code to a single call.
 */
export async function withPayableInvoicesForRuns<
  TOrder extends { id: string },
  TStop extends { orders?: TOrder[] | null },
  TRun extends { stops: TStop[] },
>(db: InvoiceFindManyClient, runs: TRun[]) {
  const allStops = await withPayableInvoices(
    db,
    runs.flatMap((r) => r.stops),
  );
  let cursor = 0;
  return runs.map((run) => {
    const stops = allStops.slice(cursor, cursor + run.stops.length);
    cursor += run.stops.length;
    return { ...run, stops };
  });
}
