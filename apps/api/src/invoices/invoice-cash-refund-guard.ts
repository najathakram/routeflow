/**
 * Money safety: an invoice part of which was handed back in CASH cannot be voided, and neither can the order that holds it
 * be cancelled (a cancel voids every live invoice of the order).
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
 * A PENDING refund (`refundedAt` null) and a REJECTED / CANCELLED return move no money, so none of them blocks
 * (`CASH_REFUNDED_RETURN_WHERE`).
 *
 * Wiring: each caller asserts ONCE, right after its row locks and before its first write (`voidInvoice`, after
 * `lockInvoiceRow`; the order cancel in `changeStatus`, after `lockOrderForCancel`). `voidInvoiceInTx` does not repeat it.
 */
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  CASH_REFUNDED_RETURN_WHERE,
  sourceLineIdsOfInvoice,
} from "../returns/inline-return-refund";

/** The 409 message of `INVOICE_HAS_CASH_REFUND` on an invoice void (web shows a generic sentence by code). */
export const INVOICE_HAS_CASH_REFUND_MESSAGE =
  "Part of this invoice was refunded in cash. Issue a credit note for the rest instead of voiding.";

/** The same code on an order cancel, worded for the order. */
export const ORDER_HAS_CASH_REFUND_MESSAGE =
  "Part of this order was refunded in cash. Issue a credit note instead of cancelling.";

/** Throws 409 INVOICE_HAS_CASH_REFUND with `message` when a recorded cash refund matches one of `sources`. Reads only. */
async function refuseOnCashRefund(
  tx: any,
  sources: Array<Record<string, unknown>>,
  message: string,
): Promise<void> {
  if (sources.length === 0) return;
  const refunded = await tx.return.findFirst({
    where: { ...CASH_REFUNDED_RETURN_WHERE, OR: sources },
    select: { id: true },
  });
  if (refunded) {
    throw new ConflictException({ code: API_ERROR_CODES.INVOICE_HAS_CASH_REFUND, message });
  }
}

/** The INLINE source clause for these invoice line ids (none: no clause). */
function inlineSourceFrom(
  lineIds: Array<string | null | undefined>,
): Array<Record<string, unknown>> {
  const ids = lineIds.filter((i): i is string => !!i);
  return ids.length > 0
    ? [{ kind: "INLINE", items: { some: { sourceInvoiceItemId: { in: ids } } } }]
    : [];
}

/**
 * Invoice void: throws 409 INVOICE_HAS_CASH_REFUND when a recorded cash refund is sourced from `invoiceId`. Reads only;
 * call it under the invoice's lock, BEFORE the first write of the void (the wallet release included), so a refusal
 * changes nothing.
 */
export async function assertNoCashRefundOnInvoice(
  tx: any,
  invoiceId: string,
  orderId: string | null,
): Promise<void> {
  const sources = inlineSourceFrom(await sourceLineIdsOfInvoice(tx, invoiceId));
  if (orderId) sources.push({ kind: "STANDARD", orderId });
  await refuseOnCashRefund(tx, sources, INVOICE_HAS_CASH_REFUND_MESSAGE);
}

/**
 * Order cancel: the same refusal for every live (non-VOID) invoice of `orderId`, with the order wording. INLINE returns
 * resolve through the lines of those invoices (one query, no per-invoice loop and no `invoice.findMany`); STANDARD returns
 * through `orderId`. Reads only; call it right after `lockOrderForCancel`, BEFORE the cancel's first write.
 */
export async function assertNoCashRefundOnOrder(tx: any, orderId: string): Promise<void> {
  const lines: Array<{ id?: string | null }> =
    (await tx.invoiceItem.findMany({
      where: { invoice: { orderId, status: { not: "VOID" } } },
      select: { id: true },
    })) ?? [];
  const sources = inlineSourceFrom(lines.map((l) => l.id));
  sources.push({ kind: "STANDARD", orderId });
  await refuseOnCashRefund(tx, sources, ORDER_HAS_CASH_REFUND_MESSAGE);
}
