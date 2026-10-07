/**
 * SA-727 (counter refund): the pieces of "refund a captured inline return in cash/card/check" that are
 * shared by the refund endpoint, the REFUND capture pre-check and the quote's additive fields.
 *
 * A refund is a RESOLUTION OF THE RETURN (the existing EXTERNAL_REFUND method), never a negative
 * InvoicePayment and never a new model: the invoice stays PAID, AR is untouched, and net sales already
 * nets an EXTERNAL_REFUND return by `refundedAt` (common/invoiced-sales.ts). The tender lives ONLY in
 * the awaited audit row (`Return.refundMethod` stays the literal EXTERNAL_REFUND until a column lands).
 */
import { Prisma, UserRole } from "@prisma/client";
import { CONFIRMED_STATUS, roundMoney, sumConfirmed } from "@routeflow/pricing";
import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";

/** The only tenders a counter refund can record. A card refund is RECORDED only; no processor is called. */
export const REFUND_TENDERS = ["CASH", "CARD", "CHECK"] as const;
export type RefundTender = (typeof REFUND_TENDERS)[number];

/** The action name of the awaited in-tx audit row a refund writes (also the replay's tender source). */
export const INLINE_REFUND_AUDIT_ACTION = "inline_return.refund";

/** `Return.refundMethod` of a refund: the existing literal, no new strings (SA-727). */
export const EXTERNAL_REFUND_METHOD = "EXTERNAL_REFUND";

/**
 * The refund gate: the same roles as the STANDARD `processRefund` route (`@Roles(UserRole.OPERATOR)`,
 * which RolesGuard satisfies with OPERATOR, TENANT_ADMIN and SUPER_ADMIN). A DRIVER or CUSTOMER never
 * refunds. One definition for the endpoint, the REFUND capture and the quote's `canRefund`.
 */
const REFUND_ROLES: ReadonlySet<string> = new Set([
  UserRole.OPERATOR,
  UserRole.TENANT_ADMIN,
  UserRole.SUPER_ADMIN,
]);
export const canRefundRole = (role: string | null | undefined): boolean =>
  role != null && REFUND_ROLES.has(role);

/** The money of an inline return: exactly what the credit mint would issue (`issueCredit`). */
export const inlineReturnAmount = (ret: {
  creditSubtotal?: unknown;
  creditTax?: unknown;
  creditCategoryTax?: unknown;
}): number =>
  roundMoney(
    Number(ret.creditSubtotal ?? 0) +
      Number(ret.creditTax ?? 0) +
      Number(ret.creditCategoryTax ?? 0),
  );

/** A return resolved by store credit or by a refund (either way it can take no second resolution). */
export const isResolvedReturn = (ret: {
  status?: string | null;
  refundMethod?: string | null;
  creditNoteId?: string | null;
}): boolean => ret.status === "REFUNDED" || ret.refundMethod != null || ret.creditNoteId != null;

/**
 * A REFUND-resolution return captured (restocked, RECEIVED, no credit note) whose refund is not recorded yet. The
 * resolution is not a column, so this is derived from the row: an INLINE return a STORE_CREDIT capture would already
 * have credited can only sit in this shape when it was captured for a refund.
 */
export const isRefundPending = (ret: {
  kind?: string | null;
  status?: string | null;
  refundMethod?: string | null;
  creditNoteId?: string | null;
  holdReason?: string | null;
}): boolean =>
  ret.kind === "INLINE" &&
  ret.status === "RECEIVED" &&
  !ret.refundMethod &&
  !ret.creditNoteId &&
  !ret.holdReason;

export interface SourceInvoicesState {
  /** Distinct source invoice ids of the returned lines (sorted). */
  invoiceIds: string[];
  /** Every returned line has a source invoice line, and every one of those invoices is non-VOID, not written off, balance 0. */
  paidInFull: boolean;
  /** The distinct methods of the CONFIRMED payments recorded on those invoices (sorted), for preselecting a tender. */
  paidMethods: string[];
}

/**
 * M3: reads the source invoices of the returned lines and answers "paid in full". FAILS CLOSED: no
 * lines, an unreferenced line (goods on no invoice), a source line that no longer exists, or an invoice
 * that is VOID / written off / owing anything is `paidInFull: false` (the caller falls back to store credit).
 * Balance is the CONFIRMED-basis one (`sumConfirmed`, the way `isOrderMetInTx` decides "paid off"): a
 * DRAFT or PENDING payment is not money received. Takes no lock itself; the refund locks the invoices first.
 */
export async function loadSourceInvoicesState(
  db: any,
  sourceInvoiceItemIds: ReadonlyArray<string | null | undefined>,
  // The refund locks the resolved invoices here, between resolving them and reading their balances.
  opts: { beforeInvoiceRead?: (invoiceIds: string[]) => Promise<void> } = {},
): Promise<SourceInvoicesState> {
  const wanted = [...new Set(sourceInvoiceItemIds.filter((i): i is string => !!i))];
  const hasUnreferenced = sourceInvoiceItemIds.some((i) => !i);
  if (wanted.length === 0) return { invoiceIds: [], paidInFull: false, paidMethods: [] };

  const lines: Array<{ id: string; invoiceId: string }> =
    (await db.invoiceItem.findMany({
      where: { id: { in: wanted } },
      select: { id: true, invoiceId: true },
    })) ?? [];
  const invoiceIds = [...new Set(lines.map((l) => l.invoiceId))].sort();
  // a source line that was deleted since the sale has no invoice to be paid: not refundable in cash
  const allLinesFound = lines.length === wanted.length;
  if (invoiceIds.length === 0) return { invoiceIds, paidInFull: false, paidMethods: [] };
  if (opts.beforeInvoiceRead) await opts.beforeInvoiceRead(invoiceIds);

  const invoices: Array<{
    id: string;
    status: string;
    total: unknown;
    payments?: Array<{ amount: unknown; status?: string; method?: string }>;
  }> =
    (await db.invoice.findMany({
      where: { id: { in: invoiceIds } },
      select: {
        id: true,
        status: true,
        total: true,
        payments: { select: { amount: true, status: true, method: true } },
      },
    })) ?? [];
  const dead = new Set<string>(CREDIT_SOURCE_EXCLUDED);
  const methods = new Set<string>();
  let allPaid = invoices.length === invoiceIds.length;
  for (const inv of invoices) {
    const payments = inv.payments ?? [];
    for (const p of payments) {
      if (p.status === CONFIRMED_STATUS && p.method) methods.add(p.method);
    }
    const balance = roundMoney(roundMoney(Number(inv.total)) - roundMoney(sumConfirmed(payments)));
    if (dead.has(inv.status) || balance > 0.001) allPaid = false;
  }
  return {
    invoiceIds,
    paidInFull: allPaid && allLinesFound && !hasUnreferenced,
    paidMethods: [...methods].sort(),
  };
}

/**
 * The refund's row locks, taken right after the Return row (house order Return -> Order -> Invoice,
 * SA-214/SA-706c). The carrying Order and every source Order go in ONE id-ordered statement (two refunds
 * whose orders cross can never hold one each and wait on the other).
 */
export async function lockRefundOrders(
  tx: any,
  tenantId: string | null,
  orderIds: ReadonlyArray<string>,
): Promise<void> {
  const orders = [...new Set(orderIds)].sort();
  if (orders.length === 0) return;
  await tx.$executeRaw`SELECT id FROM "Order" WHERE id IN (${Prisma.join(orders)}) AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
}

/** Then every source Invoice, id-sorted, so a payment void or a credit note on one serializes against the paid-in-full read. */
export async function lockRefundInvoices(
  tx: any,
  tenantId: string | null,
  invoiceIds: ReadonlyArray<string>,
): Promise<void> {
  const invoices = [...new Set(invoiceIds)].sort();
  if (invoices.length === 0) return;
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id IN (${Prisma.join(invoices)}) AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
}
