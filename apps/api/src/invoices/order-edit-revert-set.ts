import { BadRequestException, ConflictException } from "@nestjs/common";
import { SETTLE_ADJUSTED_PAYMENT_WHERE } from "./settle-adjusted-payment";
import { InvoiceStatus, UserRole } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockRowsNoWait } from "../common/db-locks";
import { carrierEditGuard, resyncsInPlace, type CarrierOrder } from "../orders/order-carrier-guard";
import { isTerminalOrderStatus } from "../common/terminal-order-statuses";

/**
 * #2178 — the ONE selection of the invoices an UNDELIVERED order edit reverts to DRAFT
 * (`InvoicesService.revertLinkedInvoicesForOrderEdit`), lifted out of that method so the inline-return
 * preflight can price against the matching set as it will be AFTER the revert: the revert turns these
 * into DRAFTs of an undelivered order, which the matching set (§3.1) does not include. One predicate,
 * never a second copy.
 *
 * The order's own non-batch SENT/VIEWED/OVERDUE invoices, minus the exempt deposit mirror: a
 * deposit-carrying invoice that is the order's SOLE non-void invoice, on an order not yet
 * DELIVERED/CANCELLED, stays SENT (the widened reconcile re-syncs it, and its payments stay attached
 * to a still-issued document). The fence reads run only when a deposit invoice is in play, so an order
 * with no deposit mirror issues exactly the one query it always did.
 */
export interface EditRevertCandidate {
  id: string;
  invoiceNumber: string;
  internalNotes: string | null;
  depositPercent: unknown;
}

interface RevertSetDb {
  invoice: {
    findMany(args: unknown): Promise<any[]>;
    count(args: unknown): Promise<number>;
  };
  order: { findFirst(args: unknown): Promise<{ status: string } | null> };
}

export async function selectEditRevertedInvoices(
  db: RevertSetDb,
  orderId: string,
): Promise<EditRevertCandidate[]> {
  const linked: EditRevertCandidate[] = await db.invoice.findMany({
    where: {
      orderId,
      deliveryBatchId: null,
      status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.OVERDUE] },
    },
    select: { id: true, invoiceNumber: true, internalNotes: true, depositPercent: true },
  });
  if (!linked.some((inv) => inv.depositPercent != null)) return linked;
  return (await depositMirrorExempt(db, orderId))
    ? linked.filter((inv) => inv.depositPercent == null)
    : linked;
}

/** The WP-D1 fence, one copy: the order is not DELIVERED/CANCELLED and the deposit mirror is its SOLE non-void invoice. */
async function depositMirrorExempt(db: RevertSetDb, orderId: string): Promise<boolean> {
  const order = await db.order.findFirst({ where: { id: orderId }, select: { status: true } });
  const nonVoidCount = await db.invoice.count({
    where: { orderId, status: { not: InvoiceStatus.VOID } },
  });
  return !!order && !isTerminalOrderStatus(order.status) && nonVoidCount === 1;
}

/** SA-1144: the invoice statuses that hold money or are closed. ONE list, read by `selectEditBlockingInvoices` and by `EDIT_BLOCKING_INVOICE_WHERE`. */
export const EDIT_BLOCKING_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.PAID,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.WRITTEN_OFF,
];

/**
 * SA-1144 Decisions 6 and 7: the Prisma where-fragment for an ORDER'S invoices (`invoices: { none: EDIT_BLOCKING_INVOICE_WHERE }`): a non-VOID,
 * non-batch invoice that is PAID, PARTIAL or WRITTEN_OFF, or that carries a live (non-VOID) payment. The customer-level auto-merge reads it
 * so a paid order is never a merge target (the new order is created on its own, never refused at placement). Broader than the edit refusal
 * on purpose: a PARTIAL deposit mirror and a SENT invoice with a payment are also not merge targets.
 */
export const EDIT_BLOCKING_INVOICE_WHERE = {
  deliveryBatchId: null,
  status: { not: InvoiceStatus.VOID },
  OR: [
    { status: { in: EDIT_BLOCKING_STATUSES } },
    // SA-1156: any live payment locks a non-DRAFT invoice; on a DRAFT only money the post-edit settle does NOT re-adjust does
    // scan-ok: draft-payment-not-void: this is a lock selection (any live payment), never a summed paid figure
    {
      status: { not: InvoiceStatus.DRAFT },
      payments: { some: { status: { not: "VOID" as const } } },
    },
    // scan-ok: draft-payment-not-void: a lock selection; the settle's own filter is the one predicate (SA-1156)
    {
      status: InvoiceStatus.DRAFT,
      payments: {
        some: { status: { not: "VOID" as const }, NOT: SETTLE_ADJUSTED_PAYMENT_WHERE },
      },
    },
  ],
};

export interface EditBlockingInvoice extends EditRevertCandidate {
  status: string;
}

/**
 * SA-1144 (W-871 reopened, Decision 7): the order's own invoices a pre-delivery edit must refuse on: the SAME where-fragment the merge
 * filter reads (`EDIT_BLOCKING_INVOICE_WHERE`: non-VOID, non-batch, PAID / PARTIAL / WRITTEN_OFF, or carrying a live payment), minus the
 * WP-D1 fence: a deposit mirror that is the order's sole non-void invoice stays exempt while it is neither PAID nor WRITTEN_OFF (the
 * widened reconcile keeps it in step; the deposit flow), but a fully PAID one is not (nothing re-syncs a settled invoice). One query,
 * plus the fence reads only when such a deposit invoice is in play.
 */
export async function selectEditBlockingInvoices(
  db: RevertSetDb,
  orderId: string,
): Promise<EditBlockingInvoice[]> {
  const held: EditBlockingInvoice[] = await db.invoice.findMany({
    where: { orderId, ...EDIT_BLOCKING_INVOICE_WHERE },
    select: {
      id: true,
      invoiceNumber: true,
      internalNotes: true,
      depositPercent: true,
      status: true,
    },
  });
  const fenceCandidate = (inv: EditBlockingInvoice) =>
    inv.depositPercent != null &&
    inv.status !== InvoiceStatus.PAID &&
    inv.status !== InvoiceStatus.WRITTEN_OFF;
  if (!held.some(fenceCandidate)) return held;
  return (await depositMirrorExempt(db, orderId))
    ? held.filter((inv) => !fenceCandidate(inv))
    : held;
}

/**
 * SA-1060 A-4 (M1): the invoices the Returns section's QUOTE must leave out while the operator is editing `orderId`, so the
 * screen prices the same post-revert matching set the edit's dry run and capture do (`preflightCapture`, `revertOrderId`).
 *
 * Reads the order (this customer's, in this tenant: any other is a 400 SOURCE_SALE_INVALID, never a probe) and applies the
 * edit's own routing rule, never a second copy: `resyncsInPlace(order.status, carrierEditGuard)` is true for an order that is out
 * for delivery, partly or fully delivered, or with the carrier, and then nothing reverts, so `[]`. Otherwise the revert runs and
 * the ids are `selectEditRevertedInvoices`' own (the order's non-batch SENT/VIEWED/OVERDUE invoices, minus an exempt deposit
 * mirror). `featureConfig` is the one reader of the business's billing moment, and it is required, so no caller reads as not with the carrier by leaving it out.
 */
export async function quoteExcludedInvoiceIds(
  db: Omit<RevertSetDb, "order"> & {
    order: { findFirst(args: unknown): Promise<any> };
  },
  customerId: string,
  orderId: string,
  featureConfig: Parameters<typeof carrierEditGuard>[0]["featureConfig"],
): Promise<string[]> {
  const order: (CarrierOrder & { id: string; status: string }) | null = await db.order.findFirst({
    where: { id: orderId, customerId },
    select: { id: true, status: true, fulfillPath: true, shippedAt: true, tenantId: true },
  });
  if (!order) {
    throw new BadRequestException({
      code: API_ERROR_CODES.SOURCE_SALE_INVALID,
      message: "That order isn't this customer's.",
    });
  }
  return (await editRevertedInvoicesFor(db, order, featureConfig)).map((inv) => inv.id);
}

/**
 * B1372 (SA-1177 K2): the invoices an items edit of `order` would turn back into drafts, by the edit's own routing rule and
 * selection (one copy: the Returns quote above and the order read's `editRevertsSentInvoices` both read it). `[]` when the
 * edit re-syncs in place (`resyncsInPlace`: out for delivery, partly or fully delivered, or with the carrier).
 */
/**
 * B1372 (SA-1177 K2, N2): ONE predicate for who meets the "this edit turns sent invoices back into drafts" confirm. The order
 * read lists the set for these roles only (`editRevertsSentInvoices`), and the edit transaction refuses an unconfirmed revert
 * for the same roles (`sentRevertNeedsAck`). A buyer or a driver never sees the confirm, so neither is ever asked for it.
 */
export function seesSentRevertConfirm(role: string | null | undefined): boolean {
  return role != null && role !== UserRole.CUSTOMER && role !== UserRole.DRIVER;
}

/**
 * B1372 N2: true when this items edit must carry `ackSentRevert` before it may revert a sent invoice: a staff editor (the
 * confirm's roles) who did not confirm. Never for the create path's own auto-merge (no confirm is shown there).
 */
export function sentRevertNeedsAck(
  user: { role?: string | null } | null | undefined,
  dto: { ackSentRevert?: boolean },
  opts?: { isCreateMerge?: boolean },
): boolean {
  return seesSentRevertConfirm(user?.role) && !opts?.isCreateMerge && dto.ackSentRevert !== true;
}

export async function editRevertedInvoicesFor(
  db: RevertSetDb,
  order: CarrierOrder & { id: string; status: string },
  featureConfig: Parameters<typeof carrierEditGuard>[0]["featureConfig"],
): Promise<EditRevertCandidate[]> {
  const guard = await carrierEditGuard(
    { featureConfig, prisma: { forTenant: () => db } as any },
    order,
  );
  if (resyncsInPlace(order.status, guard)) return [];
  return selectEditRevertedInvoices(db, order.id);
}

/**
 * When an order with a SENT (non-draft) pending-mirror invoice is edited, bring
 * that invoice back to DRAFT so the edit re-syncs into it instead of silently
 * diverging (the "edit after send" price-drift class). Only invoices with ZERO
 * payments are auto-reverted; a paid/partly-paid invoice throws instead — money
 * must never silently detach from a sent document. Per-batch delivery invoices
 * (deliveryBatchId != null, only on delivered orders) are never touched. Returns
 * the reverted invoice ids (empty when there's nothing to revert). Call BEFORE
 * mutating the order, so a payment-block aborts the whole edit cleanly.
 *
 * WP-D1 EXEMPTION (B1): a deposit mirror issued at ORDER PLACEMENT is SENT on
 * purpose and must survive an edit. Reverting it would be IRREVERSIBLE — a
 * pre-delivery order-linked DRAFT can never be re-sent (assertOrderInvoiceUnlocked
 * refuses without the create-path-only `allowPreDelivery` hatch), so the deposit
 * the customer was asked to pay would silently un-issue. It doesn't need reverting
 * either: reconcileOrderDraftInvoice's widened branch keeps exactly this invoice in
 * lockstep with the edit while it stays SENT. The exemption therefore mirrors that
 * branch's fence EXACTLY — deposit-carrying, the order's SOLE non-void invoice, and
 * the order not yet DELIVERED/CANCELLED — so an invoice is skipped here only when
 * the reconcile provably picks it up. Anything outside the fence (split/partial
 * siblings, a delivered order) keeps the legacy revert, including its
 * throw-on-payments guard.
 *
 * `opts.lockRows` takes the SAME Invoice row lock `recordPayment` holds before counting that
 * invoice's payments, so a payment cannot commit between the count and the DRAFT flip. It is
 * opt-in because only a caller already inside a transaction can hold it usefully, and because
 * the row is then held for the rest of that tx — the caller owns keeping Invoice last in the
 * lock order (`lockRowsNoWait`). Contention surfaces as a retryable 409 (NOWAIT), not a wait.
 * The caller clears the display-unit snapshot of each returned id (SA-827 rule 5 / B1275: a DRAFT renders live): the
 * display helpers are named only by the owning services (invoice-unit-display-only.spec.ts, G1).
 * `opts.preflightOnly` (row 586, SA-814a item 4): only the payment-block throw, nothing written, so a caller outside
 * a transaction can refuse a paid mirror early without committing a revert a later binding 409 cannot undo.
 * `opts.requireAck` (B1372 N2): the editor did not confirm the revert (`sentRevertNeedsAck`), so a non-empty set is a 409
 * naming the invoices, read under the row lock and thrown before any write (the confirm is enforced where the state is true).
 */
export async function revertLinkedInvoicesToDraft(
  db: any,
  orderId: string,
  opts?: { lockRows?: boolean; preflightOnly?: boolean; requireAck?: boolean },
): Promise<string[]> {
  // SA-1144 (Decision 1): under the caller's tx the order's invoices are locked FIRST (the lock `recordPayment` takes), and both
  // sets are read from the locked rows, so a final payment cannot land between the read and the commit.
  if (opts?.lockRows) {
    const open: Array<{ id: string }> = await db.invoice.findMany({
      where: { orderId, deliveryBatchId: null, status: { not: InvoiceStatus.VOID } },
      select: { id: true },
    });
    await lockRowsNoWait(
      db,
      "Invoice",
      open.map((inv) => inv.id),
      "INVOICE_BUSY",
    );
  }
  // #2178: the ONE selection (incl. the exempt deposit mirror, which stays SENT) — shared with the
  // inline-return preflight, which prices against the matching set as it will be after this revert.
  const linked = await selectEditRevertedInvoices(db, orderId);
  // SA-1144: a paid, part-paid or written-off invoice (or one holding a live payment) cannot follow an edit of its order, so the
  // edit is refused (400) before anything is written.
  const blocking = await selectEditBlockingInvoices(db, orderId);
  if (blocking.length > 0) {
    const first = blocking[0];
    const closed = EDIT_BLOCKING_STATUSES.includes(first.status as InvoiceStatus);
    throw new BadRequestException({
      code: API_ERROR_CODES.ORDER_EDIT_INVOICE_HAS_PAYMENTS,
      message: !closed
        ? `This order can't be edited while invoice ${first.invoiceNumber} has payments recorded. ` +
          `Void the invoice or remove its payments first.`
        : first.status === InvoiceStatus.WRITTEN_OFF
          ? `Invoice ${first.invoiceNumber} is written off, so this order's items can't change here. ` +
            `Put the extra items on a new order.`
          : `Invoice ${first.invoiceNumber} has payments recorded, so this order's items can't change here. ` +
            `Remove its payments first, or put the extra items on a new order.`,
    });
  }
  if (opts?.requireAck && !opts.preflightOnly && linked.length > 0) {
    const invoiceNumbers = linked.map((inv) => inv.invoiceNumber);
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_EDIT_REVERTS_SENT_INVOICE,
      message: `This edit turns invoice ${invoiceNumbers.join(", ")} back into a draft. Confirm to continue.`,
      invoiceNumbers,
    });
  }
  const reverted: string[] = [];
  for (const inv of linked) {
    // (under `lockRows` the row is already held: the lock above covers every non-void invoice of the order)
    if (opts?.preflightOnly) continue; // row 586: the read-only pre-tx check; the revert runs in the edit tx
    const auditLine = `[${new Date().toLocaleDateString()} — reverted to Draft: source order edited]`;
    await db.invoice.update({
      where: { id: inv.id },
      data: {
        status: InvoiceStatus.DRAFT,
        sentAt: null,
        pdfUrl: null,
        internalNotes: inv.internalNotes ? `${inv.internalNotes}\n${auditLine}` : auditLine,
      },
    });
    reverted.push(inv.id);
  }
  return reverted;
}
