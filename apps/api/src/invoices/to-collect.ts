import { Logger } from "@nestjs/common";
import { InvoiceStatus, type Prisma } from "@prisma/client";
import { OPEN_INVOICE_STATUSES } from "./invoice-status-sets";

/**
 * SA-1026 Part A: "To collect". A named customer's sale can be saved with nothing paid yet when staff say which method is
 * expected (a check not received). The mark is a typed INTENT on the invoice (`Invoice.expectedPaymentMethod`, set by
 * `markToCollect`, the one writer); "To collect" itself is DERIVED on every read from that intent and the invoice status,
 * which the payment writers already move (PAID, PARTIAL, VOID, WRITTEN_OFF). No payment row, no second writer of payment
 * state, and nothing to clear. Clients never compute it: the wire carries `toCollect`.
 *
 * Everything that decides or lists "To collect" lives in this file (OP-7): `toCollectState` for a row,
 * `TO_COLLECT_WHERE` for the list filter and the AR aging column, `rollupToCollect` for an order of several invoices.
 * `to-collect.spec.ts` pins them against each other for every InvoiceStatus.
 */

/** Mirrors `TO_COLLECT_METHOD_VALUES` in @routeflow/types (API source never value-imports that package); pinned by a parity spec. */
export const TO_COLLECT_METHOD_VALUES = ["CHECK"] as const;
export type ToCollectMethod = (typeof TO_COLLECT_METHOD_VALUES)[number];

/** Mirrors `TO_COLLECT_STATE_VALUES` in @routeflow/types. UNKNOWN is shown as To collect (fail closed), never hidden. */
export type ToCollectState = "TO_COLLECT" | "NONE" | "UNKNOWN";

/**
 * Settled, dead or forgiven: nothing is left owed, so the tag is gone. Together with `OPEN_INVOICE_STATUSES` and DRAFT this
 * names every InvoiceStatus (the spec fails when a new status is added, so it gets a decision here).
 */
export const CLEARED_INVOICE_STATUSES = [
  InvoiceStatus.PAID,
  InvoiceStatus.VOID,
  InvoiceStatus.WRITTEN_OFF,
] as const;

const OPEN: readonly string[] = OPEN_INVOICE_STATUSES;
const CLEARED: readonly string[] = CLEARED_INVOICE_STATUSES;
const logger = new Logger("ToCollect");
const warnedStatuses = new Set<string>();

/**
 * The state of one invoice. No intent is NONE. An intent with an open status is TO_COLLECT; with PAID, VOID or WRITTEN_OFF it
 * is cleared (NONE). Anything else (a DRAFT, a status this rule has never seen) is UNKNOWN: logged once per status and SHOWN
 * as To collect, so a staff member never loses sight of an invoice the rule cannot judge.
 */
export function toCollectState(inv: {
  expectedPaymentMethod?: string | null;
  status: string;
}): ToCollectState {
  if (inv.expectedPaymentMethod == null) return "NONE";
  if (OPEN.includes(inv.status)) return "TO_COLLECT";
  if (CLEARED.includes(inv.status)) return "NONE";
  if (!warnedStatuses.has(inv.status)) {
    warnedStatuses.add(inv.status);
    logger.warn(`to-collect: no rule for invoice status ${inv.status}; shown as To collect`);
  }
  return "UNKNOWN";
}

/**
 * The list filter, the same rule as `toCollectState` as a Prisma where: an intent and a status that is not cleared, so it lists
 * exactly the TO_COLLECT and UNKNOWN rows (an unknown status is listed, never hidden). It carries no tenant: callers add theirs.
 */
export const TO_COLLECT_WHERE: Prisma.InvoiceWhereInput = {
  expectedPaymentMethod: { not: null },
  status: { notIn: [...CLEARED_INVOICE_STATUSES] },
};

/** One answer for an order or sale that holds several invoices: any TO_COLLECT wins, then UNKNOWN, else NONE. */
export function rollupToCollect(states: readonly ToCollectState[]): ToCollectState {
  if (states.includes("TO_COLLECT")) return "TO_COLLECT";
  if (states.includes("UNKNOWN")) return "UNKNOWN";
  return "NONE";
}

/**
 * The ONE writer of the intent. Sets it only where none is set yet (a replay, or a second request with a different method,
 * keeps the FIRST intent), scoped to the tenant. Zero ids throw: a caller that lost its invoices must not read as marked
 * (L-202). The caller passes the invoices that can still be owed (the open statuses); this never judges status.
 * Returns how many invoices it newly marked.
 */
export async function markToCollect(
  tx: Pick<Prisma.TransactionClient, "invoice">,
  input: { tenantId: string; invoiceIds: readonly string[]; method: ToCollectMethod },
): Promise<number> {
  if (input.invoiceIds.length === 0) {
    throw new Error("markToCollect: no invoice to mark");
  }
  if (!(TO_COLLECT_METHOD_VALUES as readonly string[]).includes(input.method)) {
    throw new Error(`markToCollect: ${String(input.method)} is not an expectable method`);
  }
  const { count } = await tx.invoice.updateMany({
    where: {
      tenantId: input.tenantId,
      id: { in: [...input.invoiceIds] },
      expectedPaymentMethod: null,
    },
    data: { expectedPaymentMethod: input.method },
  });
  return count;
}

/**
 * What both tender paths call once the invoices are issued: marks every invoice that can still be owed (an open status) and
 * skips the rest (a settled or dead one has nothing to collect; a DRAFT is logged, it should have been sent by now). One
 * tenant transaction; nothing is marked, and no transaction opened, when no invoice is open. Replay-safe (see `markToCollect`).
 */
export async function markOpenInvoicesToCollect(
  prisma: {
    getTenantId(): string | null | undefined;
    tenantTransaction<T>(
      fn: (tx: Pick<Prisma.TransactionClient, "invoice">) => Promise<T>,
    ): Promise<T>;
  },
  invoices: readonly { id: string; status: string }[],
  method: ToCollectMethod,
): Promise<number> {
  const tenantId = prisma.getTenantId();
  if (!tenantId) throw new Error("markOpenInvoicesToCollect: no tenant in context");
  const open = invoices.filter((i) => OPEN.includes(i.status));
  const drafts = invoices.filter((i) => i.status === InvoiceStatus.DRAFT).length;
  if (drafts > 0)
    logger.warn(`to-collect: ${drafts} DRAFT invoice(s) left unmarked (not issued yet)`);
  if (open.length === 0) return 0;
  return prisma.tenantTransaction((tx) =>
    markToCollect(tx, { tenantId, invoiceIds: open.map((i) => i.id), method }),
  );
}

/**
 * AR aging's "To collect" column (staff only): per customer, how many open invoices read To collect (TO_COLLECT or UNKNOWN,
 * shown never hidden) and the sum of their balances, cents-exact. The rows carry the state `toCollectState` already gave
 * them; this only groups. A customer with none is absent. Ordered by customer id for a stable response.
 */
export function toCollectByCustomer(
  rows: readonly {
    customerId: string;
    businessName: string;
    balance: number;
    toCollect: ToCollectState;
  }[],
): { customerId: string; businessName: string; count: number; balance: number }[] {
  const by = new Map<
    string,
    { customerId: string; businessName: string; count: number; balance: number }
  >();
  for (const r of rows) {
    if (r.toCollect === "NONE" || r.balance <= 0) continue;
    const cur = by.get(r.customerId) ?? {
      customerId: r.customerId,
      businessName: r.businessName,
      count: 0,
      balance: 0,
    };
    cur.count += 1;
    cur.balance = Math.round((cur.balance + r.balance) * 100) / 100;
    by.set(r.customerId, cur);
  }
  return [...by.values()].sort((a, b) => (a.customerId < b.customerId ? -1 : 1));
}
