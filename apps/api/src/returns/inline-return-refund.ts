/**
 * SA-727 (counter refund): the pieces of "refund a captured inline return in cash/card/check" that are
 * shared by the refund endpoint, the REFUND capture pre-check and the quote's additive fields.
 *
 * A refund is a RESOLUTION OF THE RETURN (the existing EXTERNAL_REFUND method), never a negative
 * InvoicePayment and never a new model: the invoice stays PAID, AR is untouched, and net sales already
 * nets an EXTERNAL_REFUND return by `refundedAt` (common/invoiced-sales.ts). The tender of record is the
 * `Return.refundTender` column (SA-740r, see refund-tender.ts), written in the same CAS as `refundedAt`; the awaited audit row
 * carries it too. `Return.refundMethod` stays the literal EXTERNAL_REFUND.
 */
import { ConflictException } from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import { CONFIRMED_STATUS, roundMoney, sumConfirmed } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";

/** The only tenders a counter refund can record. A card refund is RECORDED only; no processor is called. */
export const REFUND_TENDERS = ["CASH", "CARD", "CHECK"] as const;
export type RefundTender = (typeof REFUND_TENDERS)[number];

/** The action name of the awaited in-tx audit row a refund writes (also the replay's tender source). */
export const INLINE_REFUND_AUDIT_ACTION = "inline_return.refund";

/** SA-727b: the awaited audit row of "Give store credit instead" ({from: REFUND_PENDING, to: STORE_CREDIT}). */
export const INLINE_STORE_CREDIT_AUDIT_ACTION = "inline_return.store_credit_instead";

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

/**
 * A return resolved by store credit or by a recorded refund (either way it can take no second resolution). A PENDING
 * refund (refundMethod EXTERNAL_REFUND stored at capture, refundedAt null, still RECEIVED) is NOT resolved yet.
 */
export const isResolvedReturn = (ret: {
  status?: string | null;
  creditNoteId?: string | null;
}): boolean => ret.status === "REFUNDED" || ret.creditNoteId != null;

/**
 * A return captured for a REFUND whose refund is not recorded yet: RECEIVED, the EXTERNAL_REFUND intent stored on the row
 * at capture, `refundedAt` still null, no credit note. Net sales and sales-facts key on `refundedAt`, so it counts nowhere.
 */
export const isRefundPending = (ret: {
  kind?: string | null;
  status?: string | null;
  refundMethod?: string | null;
  refundedAt?: unknown;
  creditNoteId?: string | null;
}): boolean =>
  ret.kind === "INLINE" &&
  ret.status === "RECEIVED" &&
  ret.refundMethod === EXTERNAL_REFUND_METHOD &&
  !ret.refundedAt &&
  !ret.creditNoteId;

/**
 * SA-727 (F4): the payment methods that are MONEY (a cash/card/check refund can hand it back). Everything else a confirmed
 * payment can carry (`CREDIT_NOTE`, `ADVANCE`) is store credit, which a refund must never turn into cash.
 */
export const MONEY_PAYMENT_METHODS = [
  "CASH",
  "CHECK",
  "CREDIT_CARD",
  "ACH",
  "ZELLE",
  "OTHER",
] as const;
export const STORE_CREDIT_PAYMENT_METHODS: ReadonlySet<string> = new Set([
  "CREDIT_NOTE",
  "ADVANCE",
]);

export interface SourceInvoicesState {
  /** Distinct source invoice ids of the returned lines (sorted). */
  invoiceIds: string[];
  /** Every returned line has a source invoice line, and every one of those invoices is non-VOID, not written off, balance 0. */
  paidInFull: boolean;
  /** The distinct methods of the CONFIRMED payments recorded on those invoices (sorted), for preselecting a tender. */
  paidMethods: string[];
  /**
   * F4: ANY part of those invoices was paid with store credit (a CONFIRMED CREDIT_NOTE or ADVANCE payment worth money). Such a
   * return goes back as store credit only: it is never refundable in cash, whatever `paidInFull` says.
   */
  paidWithStoreCredit: boolean;
}

/**
 * The one refund-eligibility rule of the sources (pure): paid in full AND none of it paid with store credit. The endpoint, the
 * REFUND capture pre-check and the quote's `canRefund` all use it (the quote adds the role gate).
 */
export const sourcesAreRefundable = (
  src: Pick<SourceInvoicesState, "paidInFull" | "paidWithStoreCredit">,
): boolean => src.paidInFull && !src.paidWithStoreCredit;

/**
 * Where a refund's invoices come from. INLINE names the returned lines' own source invoice items; STANDARD has no line link
 * (`ReturnItem.sourceInvoiceItemId` is null on every STANDARD row), so it takes the order's invoices that can still source a
 * credit (not VOID, not WRITTEN_OFF).
 */
export type RefundInvoiceSource =
  | { kind: "LINES"; sourceInvoiceItemIds: ReadonlyArray<string | null | undefined> }
  | { kind: "ORDER"; orderId: string };

export interface ResolvedRefundInvoices {
  /** Distinct invoice ids (sorted), to be locked before they are read. */
  invoiceIds: string[];
  /** False when the set cannot vouch for the whole return: an unreferenced line, a source line that is gone, or no invoice. */
  complete: boolean;
}

/**
 * THE one resolver of "which invoices does this refund need paid" (SA-740r2 item 1), for INLINE and STANDARD alike. Takes no
 * lock; the caller locks `invoiceIds` and then reads their state with {@link loadInvoiceRefundState}. FAILS CLOSED: an
 * unreferenced line, a deleted source line or an order with no creditable invoice is `complete: false`.
 */
export async function resolveRefundInvoiceIds(
  db: any,
  source: RefundInvoiceSource,
): Promise<ResolvedRefundInvoices> {
  if (source.kind === "ORDER") {
    const rows: Array<{ id: string }> =
      (await db.invoice.findMany({
        where: { orderId: source.orderId, status: { notIn: [...CREDIT_SOURCE_EXCLUDED] } },
        select: { id: true },
      })) ?? [];
    const invoiceIds = [...new Set(rows.map((r) => r.id))].sort();
    return { invoiceIds, complete: invoiceIds.length > 0 };
  }
  const ids = source.sourceInvoiceItemIds;
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  const hasUnreferenced = ids.some((i) => !i);
  if (wanted.length === 0) return { invoiceIds: [], complete: false };
  const lines: Array<{ id: string; invoiceId: string }> =
    (await db.invoiceItem.findMany({
      where: { id: { in: wanted } },
      select: { id: true, invoiceId: true },
    })) ?? [];
  const invoiceIds = [...new Set(lines.map((l) => l.invoiceId))].sort();
  // a source line that was deleted since the sale has no invoice to be paid: not refundable in cash
  return { invoiceIds, complete: lines.length === wanted.length && !hasUnreferenced };
}

/**
 * Reads the state of the resolved invoices: paid in full (non-VOID, not written off, balance 0 on the CONFIRMED basis,
 * `sumConfirmed`, the way `isOrderMetInTx` decides "paid off": a DRAFT or PENDING payment is not money received), the payment
 * methods, and whether any of it was paid with store credit (F4). Takes no lock itself; the refund locks the invoices first
 * (`beforeInvoiceRead`, between resolving them and reading their balances).
 */
export async function loadInvoiceRefundState(
  db: any,
  resolved: ResolvedRefundInvoices,
  opts: { beforeInvoiceRead?: (invoiceIds: string[]) => Promise<void> } = {},
): Promise<SourceInvoicesState> {
  const { invoiceIds } = resolved;
  if (invoiceIds.length === 0) {
    return { invoiceIds, paidInFull: false, paidMethods: [], paidWithStoreCredit: false };
  }
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
  let paidWithStoreCredit = false;
  for (const inv of invoices) {
    const payments = inv.payments ?? [];
    for (const p of payments) {
      if (p.status === CONFIRMED_STATUS && p.method) {
        methods.add(p.method);
        if (STORE_CREDIT_PAYMENT_METHODS.has(p.method) && roundMoney(Number(p.amount)) > 0.001) {
          paidWithStoreCredit = true;
        }
      }
    }
    const balance = roundMoney(roundMoney(Number(inv.total)) - roundMoney(sumConfirmed(payments)));
    if (dead.has(inv.status) || balance > 0.001) allPaid = false;
  }
  return {
    invoiceIds,
    paidInFull: allPaid && resolved.complete,
    paidMethods: [...methods].sort(),
    paidWithStoreCredit,
  };
}

/**
 * M3: reads the source invoices of the returned lines and answers "paid in full". FAILS CLOSED: no
 * lines, an unreferenced line (goods on no invoice), a source line that no longer exists, or an invoice
 * that is VOID / written off / owing anything is `paidInFull: false` (the caller falls back to store credit).
 * The INLINE composition of {@link resolveRefundInvoiceIds} + {@link loadInvoiceRefundState}.
 */
export async function loadSourceInvoicesState(
  db: any,
  sourceInvoiceItemIds: ReadonlyArray<string | null | undefined>,
  // The refund locks the resolved invoices here, between resolving them and reading their balances.
  opts: { beforeInvoiceRead?: (invoiceIds: string[]) => Promise<void> } = {},
): Promise<SourceInvoicesState> {
  return loadInvoiceRefundState(
    db,
    await resolveRefundInvoiceIds(db, { kind: "LINES", sourceInvoiceItemIds }),
    opts,
  );
}

/**
 * The refusal of a refund whose sources are not refundable (the ONE definition: INLINE refund, REFUND capture and STANDARD
 * `processRefund` all throw it): 409 REFUND_NEEDS_PAID_INVOICE, or REFUND_PAID_WITH_STORE_CREDIT for store credit that must
 * not become cash. The operator's exits are named in the copy: store credit when the goods are billable, else cancel the return.
 */
export function refundSourcesRefusal(
  src: Pick<SourceInvoicesState, "paidInFull" | "paidWithStoreCredit">,
): ConflictException | null {
  if (!src.paidInFull) {
    return new ConflictException({
      code: API_ERROR_CODES.REFUND_NEEDS_PAID_INVOICE,
      message:
        "A refund needs every invoice the goods were sold on to be paid in full. Issue store credit instead, or cancel the return.",
    });
  }
  if (src.paidWithStoreCredit) {
    return new ConflictException({
      code: API_ERROR_CODES.REFUND_PAID_WITH_STORE_CREDIT,
      message:
        "Paid with store credit, so it goes back as store credit. Issue store credit instead.",
    });
  }
  return null;
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
