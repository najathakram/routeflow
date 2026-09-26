import { InvoiceStatus } from "@prisma/client";
import { formatMoney } from "../messaging/messaging.helpers";

/**
 * #2255 / SA-404: the send and void decisions as pure guards. Each Serializable send/void tx is
 * retried on a write conflict (`retryOnTxConflict`), and a retry runs on a FRESH snapshot — so a
 * decision taken from a PRE-tx read could write SENT over a concurrent VOID, or void an invoice
 * that just took a cash payment (the 40001 used to stop both). Each guard is therefore called
 * twice, the SA-389 shape: pre-tx as the fast refusal, and in-tx on the row re-read under
 * {@link lockInvoiceRow} as the authoritative one.
 */

/** send()/sendEmail(): the refusal to throw (400), or null. */
export function sendRefusal(status: InvoiceStatus): string | null {
  return status === InvoiceStatus.VOID ? "Cannot send a voided invoice" : null;
}

/** Only flip DRAFT → SENT. Re-sending an invoice that credit auto-apply already made PAID/PARTIAL
 *  must NOT downgrade it (auto-apply returns early on a zero balance and won't restore the status),
 *  which would leave paidAt stale (P5-13). */
export function nextSentStatus(status: InvoiceStatus): InvoiceStatus {
  return status === InvoiceStatus.DRAFT ? InvoiceStatus.SENT : status;
}

/** voidInvoice(): the refusal to throw (400) when cash/check/card money sits on the invoice. */
export function voidRefusal(externalPaid: number): string | null {
  return externalPaid > 0.001
    ? `Cannot void an invoice with ${formatMoney(externalPaid)} in cash/check/card payments. Reverse or refund those payments first.`
    : null;
}

/**
 * The tx's FIRST statement: take the row locks in the SA-214 global order (the ORDER row first when
 * the invoice has one, then the Invoice), then re-read the invoice with its payments under them.
 */
export async function lockInvoiceRow(tx: any, id: string, orderId: string | null) {
  if (orderId) await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;
  return tx.invoice.findUnique({ where: { id }, include: { payments: true } });
}
