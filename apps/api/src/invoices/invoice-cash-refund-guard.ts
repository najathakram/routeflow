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
import { CASH_REFUNDED_RETURN_WHERE, sourceRefsOfInvoice } from "../returns/inline-return-refund";

/** The 409 message of `INVOICE_HAS_CASH_REFUND` on an invoice void (web shows a generic sentence by code). */
export const INVOICE_HAS_CASH_REFUND_MESSAGE =
  "Part of this invoice was refunded in cash. Issue a credit note for the rest instead of voiding.";

/** The 409 message of `ORDER_HAS_CASH_REFUND` on an order cancel (its own code, worded for the order). */
export const ORDER_HAS_CASH_REFUND_MESSAGE =
  "Part of this order was refunded in cash. Issue a credit note instead of cancelling.";

/** Throws 409 `code` with `message` when a recorded cash refund matches one of `sources`. Reads only. */
async function refuseOnCashRefund(
  tx: any,
  sources: Array<Record<string, unknown>>,
  code: string,
  message: string,
): Promise<void> {
  if (sources.length === 0) return;
  const refunded = await tx.return.findFirst({
    where: { ...CASH_REFUNDED_RETURN_WHERE, OR: sources },
    select: { id: true },
  });
  if (refunded) {
    throw new ConflictException({ code, message });
  }
}

/**
 * The INLINE source clauses for these invoice lines (none: no clause). The reverse of the refund's resolution
 * (`resolveInlineSourceInvoices`): an item is sourced from the invoice by its stored line id, OR, when a rebuild of the order's
 * invoice lines left that id DANGLING (no invoice line of the order has it any more), by the order line (`sourceOrderItemId`)
 * one of the invoice's lines carries, on the invoice's own order. Without the second clause a cash refund of a rebuilt line
 * (refundable since row 347) would not block the void of the invoice it was paid back against. The second clause is narrowed to
 * dangling references: an item whose stored line is ALIVE on a sibling invoice (one order line billed on two invoices, 6 + 4)
 * belongs to that sibling, so a cash refund of the sibling's goods never blocks voiding this invoice. `orderLineIds` is every
 * invoice line of the order, whatever its invoice's status.
 */
function inlineSourceFrom(
  lines: Array<{ id?: string | null; orderItemId?: string | null }>,
  orderId: string | null,
  orderLineIds: ReadonlyArray<string>,
): Array<Record<string, unknown>> {
  const ids = lines.map((l) => l.id).filter((i): i is string => !!i);
  const orderItemIds = [
    ...new Set(lines.map((l) => l.orderItemId).filter((i): i is string => !!i)),
  ];
  const clauses: Array<Record<string, unknown>> = [];
  if (ids.length > 0)
    clauses.push({ kind: "INLINE", items: { some: { sourceInvoiceItemId: { in: ids } } } });
  if (orderItemIds.length > 0)
    clauses.push({
      kind: "INLINE",
      items: {
        some: {
          sourceOrderItemId: { in: orderItemIds },
          sourceInvoiceItemId: { notIn: [...orderLineIds] },
          ...(orderId ? { OR: [{ sourceOrderId: orderId }, { sourceOrderId: null }] } : {}),
        },
      },
    });
  return clauses;
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
  const refs = await sourceRefsOfInvoice(tx, invoiceId);
  // every invoice line of the order: a stored line id in it is NOT dangling (it is alive, on this invoice or a sibling)
  const orderLines: Array<{ id?: string | null }> =
    orderId && refs.orderItemIds.length > 0
      ? ((await tx.invoiceItem.findMany({
          where: { invoice: { orderId } },
          select: { id: true },
        })) ?? [])
      : [];
  const sources = inlineSourceFrom(
    [
      ...refs.lineIds.map((id) => ({ id })),
      ...refs.orderItemIds.map((orderItemId) => ({ orderItemId })),
    ],
    orderId,
    orderLines.map((l) => l.id).filter((i): i is string => !!i),
  );
  if (orderId) sources.push({ kind: "STANDARD", orderId });
  await refuseOnCashRefund(
    tx,
    sources,
    API_ERROR_CODES.INVOICE_HAS_CASH_REFUND,
    INVOICE_HAS_CASH_REFUND_MESSAGE,
  );
}

/**
 * Order cancel: the same refusal (409 ORDER_HAS_CASH_REFUND) for every live (non-VOID) invoice of `orderId`, with the order wording. INLINE returns
 * resolve through the lines of those invoices (one query, no per-invoice loop and no `invoice.findMany`); STANDARD returns
 * through `orderId`. Reads only; call it right after `lockOrderForCancel`, BEFORE the cancel's first write.
 */
export async function assertNoCashRefundOnOrder(tx: any, orderId: string): Promise<void> {
  // ONE query: every line of the order's invoices with its invoice's status (the live ones are the sources, all of them tell a
  // dangling stored id from one that is alive on a voided sibling)
  const all: Array<{
    id?: string | null;
    orderItemId?: string | null;
    invoice?: { status?: string | null } | null;
  }> =
    (await tx.invoiceItem.findMany({
      where: { invoice: { orderId } },
      select: { id: true, orderItemId: true, invoice: { select: { status: true } } },
    })) ?? [];
  const lines = all.filter((l) => !(l.invoice?.status === "VOID")); // Invoice's own status, not a payment's
  const sources = inlineSourceFrom(
    lines,
    orderId,
    all.map((l) => l.id).filter((i): i is string => !!i),
  );
  sources.push({ kind: "STANDARD", orderId });
  await refuseOnCashRefund(
    tx,
    sources,
    API_ERROR_CODES.ORDER_HAS_CASH_REFUND,
    ORDER_HAS_CASH_REFUND_MESSAGE,
  );
}
