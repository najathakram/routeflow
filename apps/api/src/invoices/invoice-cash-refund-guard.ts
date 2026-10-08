/**
 * Money safety: an invoice part of which was handed back in CASH cannot be voided.
 *
 * A counter refund is a RESOLUTION OF THE RETURN (`Return.refundMethod` EXTERNAL_REFUND with `refundedAt` set), never a
 * negative payment, so the invoice still reads PAID and its payments hold no trace of the cash that left the till. Voiding it
 * would reverse the whole sale while the cash already went back, so the refunded part is paid out twice. The way out is a
 * credit note for the rest.
 *
 * Which returns count as "sourced from this invoice":
 *   - INLINE returns, through their lines: `ReturnItem.sourceInvoiceItemId` -> `InvoiceItem.invoiceId` (the same resolution
 *     `loadSourceInvoicesState` makes, read in reverse). The invoice of an inline return's CARRYING order is the new sale,
 *     not a source, so the order link is not used for them.
 *   - STANDARD returns, through their order: `Return.orderId` is the invoice's `orderId` (a standard return carries no
 *     per-line invoice link). Conservative on a split order: any invoice of that order is held.
 * A PENDING refund (`refundedAt` null) and a CANCELLED return move no money, so neither blocks (`CASH_REFUNDED_RETURN_WHERE`).
 */
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  CASH_REFUNDED_RETURN_WHERE,
  sourceLineIdsOfInvoice,
} from "../returns/inline-return-refund";

/** The 409 message of `INVOICE_HAS_CASH_REFUND` (web shows the same sentence by code). */
export const INVOICE_HAS_CASH_REFUND_MESSAGE =
  "Part of this invoice was refunded in cash. Issue a credit note for the rest instead of voiding.";

/**
 * Throws 409 INVOICE_HAS_CASH_REFUND when a recorded cash refund is sourced from `invoiceId`. Reads only; call it
 * under the invoice's lock, BEFORE the first write of the void, so a refusal changes nothing.
 */
export async function assertNoCashRefundOnInvoice(
  tx: any,
  invoiceId: string,
  orderId: string | null,
): Promise<void> {
  const sources: Array<Record<string, unknown>> = [];
  const lineIds = await sourceLineIdsOfInvoice(tx, invoiceId);
  if (lineIds.length > 0) {
    sources.push({ kind: "INLINE", items: { some: { sourceInvoiceItemId: { in: lineIds } } } });
  }
  if (orderId) sources.push({ kind: "STANDARD", orderId });
  if (sources.length === 0) return;

  const refunded = await tx.return.findFirst({
    where: { ...CASH_REFUNDED_RETURN_WHERE, OR: sources },
    select: { id: true },
  });
  if (refunded) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_HAS_CASH_REFUND,
      message: INVOICE_HAS_CASH_REFUND_MESSAGE,
    });
  }
}
