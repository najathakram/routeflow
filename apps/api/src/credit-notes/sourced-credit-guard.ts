import { ConflictException } from "@nestjs/common";
import { CreditNoteStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";

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
 */
export async function assertNoUnspentSourcedCredits(tx: any, invoiceIds: string[]): Promise<void> {
  if (invoiceIds.length === 0) return;
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
  throw new ConflictException({
    code: "INVOICE_HAS_UNSPENT_CREDIT",
    message:
      `This invoice issued credit ${open.map((cn: any) => cn.creditNoteNumber).join(", ")} ` +
      `with ${unspent.toFixed(2)} still unspent. Void the invoice instead — voiding retires the ` +
      `unspent credit and keeps the audit trail.`,
    creditNotes: open.map((cn: any) => ({
      id: cn.id,
      creditNoteNumber: cn.creditNoteNumber,
      remaining: remainingOf(cn),
    })),
  });
}
