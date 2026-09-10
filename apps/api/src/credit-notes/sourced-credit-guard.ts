import { ConflictException } from "@nestjs/common";
import { CreditNoteStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";

import { lockRowsNoWait } from "../common/db-locks";

/**
 * B214 (REG-B214): the ONE home of "a credit note sourced by an invoice still carries spendable
 * balance", for every door that destroys an invoice (InvoicesService.deleteInvoice and
 * OrdersService.deleteOrder's inline invoice loop). L-072: never re-inline this per door.
 *
 * Canonical open predicate (documented at CreditNotesService.autoApplyOldestCreditsInTx):
 *   status != VOID && (amount − amountUsed) > 0.001 && (expiresAt == null || expiresAt > now)
 * Exclude-list on status (L-081): only VOID is closed, so a row without `status` counts as open.
 *
 * Delete REFUSES where void (InvoicesService.voidInvoiceInTx) voids/caps: void keeps the audit
 * trail, delete does not (cause ruling 2026-09-09).
 */
export const OPEN_CREDIT_EPSILON = 0.001;

export function isOpenCreditNote(
  cn: {
    status?: string | null;
    amount?: unknown;
    amountUsed?: unknown;
    expiresAt?: Date | string | null;
  },
  now: Date = new Date(),
): boolean {
  if (cn.status === CreditNoteStatus.VOID) return false;
  if (cn.expiresAt != null && new Date(cn.expiresAt) <= now) return false;
  return roundMoney(Number(cn.amount ?? 0) - Number(cn.amountUsed ?? 0)) > OPEN_CREDIT_EPSILON;
}

/**
 * Throws 409 INVOICE_HAS_UNSPENT_CREDIT when any credit note sourced by one of `invoiceIds` is
 * still open. Call INSIDE the deleting transaction, BEFORE any write, with that tx.
 *
 * `opts.afterRelease` is for the SECOND call a delete makes, once the wallet releases have
 * revived notes the first read saw spent: "void the invoice instead" is the same advice, but the
 * cause is the release, not a balance the operator could have seen beforehand.
 *
 * `opts.lockRows` closes the TOCTOU window between this read and the rows going away, by taking
 * the Invoice rows a concurrent void/restore/payment writes. It is OPT-IN because the lock is
 * held for the REST of the tx, so it must not become the caller's FIRST lock: every other writer
 * of these rows takes InvoicePayment → CreditNote → Invoice (CreditNotesService.voidInvoice), and
 * a blocking lock taken after a NOWAIT row held out of order can still close a 40P01 cycle. Only
 * a caller whose tx already holds the payment/credit rows passes it — today just deleteOrder's
 * post-release call. At the other doors the residual read-then-delete window is accepted and
 * filed.
 */
export async function assertNoUnspentSourcedCredits(
  tx: any,
  invoiceIds: string[],
  opts?: { afterRelease?: boolean; lockRows?: boolean },
): Promise<void> {
  if (invoiceIds.length === 0) return;
  // The open-credit read below decides whether rows may be destroyed, so a caller that can hold
  // Invoice LAST takes it here. NOWAIT — contention is a retryable 409, never a wait.
  if (opts?.lockRows) await lockRowsNoWait(tx, "Invoice", invoiceIds, "INVOICE_BUSY");
  const now = new Date();
  const sourced = await tx.creditNote.findMany({
    where: { invoiceId: { in: invoiceIds }, status: { not: CreditNoteStatus.VOID } },
    select: {
      id: true,
      creditNoteNumber: true,
      invoiceId: true,
      amount: true,
      amountUsed: true,
      status: true,
      expiresAt: true,
    },
  });
  // Defense-in-depth scoping (mirrors voidInvoiceInTx / wallet-integrity T11): only notes these
  // invoices actually sourced can block the delete, whatever the query returned.
  const open = (sourced ?? []).filter(
    (cn: any) => invoiceIds.includes(cn.invoiceId) && isOpenCreditNote(cn, now),
  );
  if (open.length === 0) return;
  const remainingOf = (cn: any) => roundMoney(Number(cn.amount ?? 0) - Number(cn.amountUsed ?? 0));
  const unspent = roundMoney(open.reduce((s: number, cn: any) => s + remainingOf(cn), 0));
  const numbers = open.map((cn: any) => cn.creditNoteNumber).join(", ");
  throw new ConflictException({
    code: "INVOICE_HAS_UNSPENT_CREDIT",
    message: opts?.afterRelease
      ? `Deleting this order would hand credit ${numbers} (${unspent.toFixed(2)} unspent) back ` +
        `to the customer. Void the invoice instead.`
      : `This invoice issued credit ${numbers} ` +
        `with ${unspent.toFixed(2)} still unspent. Void the invoice instead — voiding retires the ` +
        `unspent credit and keeps the audit trail.`,
    creditNotes: open.map((cn: any) => ({
      id: cn.id,
      creditNoteNumber: cn.creditNoteNumber,
      remaining: remainingOf(cn),
    })),
  });
}
