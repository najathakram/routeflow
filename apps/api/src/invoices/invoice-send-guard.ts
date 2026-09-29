import { InvoiceStatus, Prisma } from "@prisma/client";
import { formatMoney } from "../messaging/messaging.helpers";
import { isBlockingPayment, roundMoney } from "@routeflow/pricing";

/**
 * #2255 / SA-404: the send and void decisions as pure guards. Each Serializable send/void tx is
 * retried on a write conflict (`retryOnTxConflict`), and a retry runs on a FRESH snapshot — so a
 * decision taken from a PRE-tx read could write SENT over a concurrent VOID, or void an invoice
 * that just took a cash payment (the 40001 used to stop both). Each guard is therefore called
 * twice, the SA-389 shape: pre-tx as the fast refusal, and in-tx on the row re-read under
 * {@link lockInvoiceRow} as the authoritative one.
 */

/** SA-404a: markSent's refusal AFTER the email went out must say so, so the operator can act. */
export const VOIDED_DURING_EMAIL =
  "The invoice was voided while its email was being sent — the customer received the email; nothing was marked sent";

/** send()/sendEmail(): the refusal to throw (400), or null. `emailSent` = the email already went out. */
export function sendRefusal(status: InvoiceStatus, emailSent = false): string | null {
  if (status !== InvoiceStatus.VOID) return null;
  return emailSent ? VOIDED_DURING_EMAIL : "Cannot send a voided invoice";
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

/**
 * SA-404f F1: a payment writer's FIRST statements — lock the invoices' ORDER rows, then the
 * invoices, each set in id order (SA-214 global order: Order → Invoice). A void takes the same
 * rows, so a writer that reads an invoice's status AFTER this sees a committed VOID and refuses,
 * instead of writing PAID/PARTIAL back over it (the void-first half of the #2258 race). The
 * orderId pre-read is safe unlocked: an invoice's orderId never changes.
 */
export async function lockInvoicesForPayment(tx: any, invoiceIds: string[]): Promise<void> {
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length === 0) return;
  const heads: Array<{ orderId: string | null }> = await tx.invoice.findMany({
    where: { id: { in: ids } },
    select: { orderId: true },
  });
  const orderIds = [...new Set(heads.map((h) => h.orderId).filter((o): o is string => !!o))].sort();
  if (orderIds.length > 0)
    await tx.$executeRaw`SELECT id FROM "Order" WHERE id IN (${Prisma.join(orderIds)}) ORDER BY id FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
}

/** #2472: an invoice may be written off only from an open, collectible status (checked on the LOCKED row). */
export function writeOffRefusal(status: InvoiceStatus): string | null {
  const open: InvoiceStatus[] = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"] as InvoiceStatus[];
  return open.includes(status) ? null : `Cannot write off an invoice with status ${status}`;
}

/** A payment may not land on a VOID or WRITTEN_OFF invoice (checked on the LOCKED row). */
export function paymentRefusal(status: InvoiceStatus): string | null {
  if (status === InvoiceStatus.VOID) return "voided";
  if (status === InvoiceStatus.WRITTEN_OFF) return "written-off";
  return null;
}

/**
 * Money on an invoice comes in two flavours and they unwind differently:
 *
 *  - **Wallet money** (CREDIT_NOTE, ADVANCE) came from a balance this system
 *    owns, so voiding can simply put it back — and MUST, or the customer's
 *    credit is silently consumed by an invoice that no longer exists.
 *  - **External money** (cash, check, card) left the customer's hands. Software
 *    cannot un-take it, so it still blocks the void until a human refunds or
 *    reverses it.
 *
 * Returns the external total so callers can decide whether to block.
 */
export function externalPaidOn(
  payments: Array<{ method?: unknown; amount: unknown; status?: string }>,
) {
  // PR-2 (check-payments B1 hardening, N4 owner ruling): isBlockingPayment (NOT
  // isHeldPayment) — a DRAFT external payment is money in flight and must keep
  // blocking the void exactly as it does today; HELD (PAID ∪ PENDING) is for money
  // TOTALS only, never an existence/blocking check. See orders.service.ts's
  // cancelImpact for the identical conversion.
  return roundMoney(
    payments
      .filter(
        (p) =>
          isBlockingPayment(p) &&
          (p.method as any) !== "CREDIT_NOTE" &&
          (p.method as any) !== "ADVANCE",
      )
      .reduce((s, p) => s + Number(p.amount), 0),
  );
}
