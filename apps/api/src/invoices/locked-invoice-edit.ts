import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { roundMoney, sumInvoiceTotals } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B1043 (SA-742r2 INV-A): the ONE locked read both branches of `InvoicesService.update()` start from,
 * and the header-only (discount / shippingFee, no `items`) totals rule built on it.
 *
 * Why it exists: the header-only branch read the lines with an unlocked `forTenant()` call, summed a tax
 * that knew neither the regulated levy nor the exempt customer, and wrote the result with a second
 * unlocked call (B1043, B405), so a concurrent line edit could land between the read and the write
 * (B1045). Now both branches lock the Order then the Invoice (the order `deleteInvoice` and every
 * invoice-from-order path take, SA-137/203), then read the invoice, its lines and the customer's
 * exemption inside the same transaction.
 */

export interface LockedInvoiceForEdit {
  /** The invoice row read UNDER the lock (never the unlocked pre-read). */
  invoice: any;
  /** Its tenant-scoped lines, read under the lock. */
  storedRows: any[];
  /** The customer's tax exemption, read in the same transaction. */
  isTaxExempt: boolean;
}

/**
 * Locks the Order (when linked) then the Invoice, and returns the invoice, its lines and the customer's
 * exemption, all read inside `tx`. Fails closed:
 *  - 404 when the invoice is gone;
 *  - 409 INVOICE_CHANGED_CONCURRENTLY when its order link moved between the peek and the lock (the order
 *    we locked is not the one it points at);
 *  - 400 when the invoice has a line whose tenant is NULL or another tenant's (B929): the tenant-scoped
 *    line read would silently drop it and under-bill the invoice.
 */
export async function loadLockedInvoiceForEdit(tx: any, id: string): Promise<LockedInvoiceForEdit> {
  const peek = await tx.invoice.findUnique({ where: { id }, select: { orderId: true } });
  if (!peek) throw new NotFoundException("Invoice not found");
  if (peek.orderId)
    await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${peek.orderId} FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;
  const invoice = await tx.invoice.findUnique({ where: { id } });
  if (!invoice) throw new NotFoundException("Invoice not found");
  if ((invoice.orderId ?? null) !== (peek.orderId ?? null)) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
      message: "The invoice changed while it was being edited. Try again.",
    });
  }
  const storedRows: any[] = await tx.invoiceItem.findMany({ where: { invoiceId: id } });
  const foreign = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM "InvoiceItem"
    WHERE "invoiceId" = ${id} AND "tenantId" IS DISTINCT FROM ${invoice.tenantId ?? null}`;
  if (Number(foreign?.[0]?.n ?? 0) > 0) {
    throw new BadRequestException(
      "This invoice has a line that isn't linked to your business, so it can't be edited safely. Contact support.",
    );
  }
  const customer = await tx.customer.findFirst({
    where: { id: invoice.customerId },
    select: { isTaxExempt: true },
  });
  return { invoice, storedRows, isTaxExempt: !!customer?.isTaxExempt };
}

/** True when two money figures differ by at least a cent (both sides rounded first, L-170). */
const differs = (a: unknown, b: unknown): boolean => roundMoney(Number(a) - Number(b)) !== 0;

/**
 * F1 — the header-only totals: lines unchanged => tax unchanged.
 *
 * Runs `sumInvoiceTotals` (pure: it never mutates the rows) over the locked lines. If its subtotal or tax differs from the
 * invoice's stored subtotal / taxAmount, the stored header cannot be trusted (a legacy draft, a rate
 * the column truncated, an exempt customer with a stale levy): refuse with 409 INVOICE_TAX_STATE_STALE
 * and write nothing. Otherwise the total is recomputed from the stored (== recomputed) subtotal and tax
 * with the new discount and shipping; only `discount`, `shippingFee` and `total` are written.
 */
export function planHeaderOnlyTotals(
  locked: LockedInvoiceForEdit,
  dto: { discount?: number; shippingFee?: number },
): { discount: number; shippingFee: number; total: number; subtotal: number } {
  const { invoice, storedRows, isTaxExempt } = locked;
  const discount = dto.discount ?? Number(invoice.discount ?? 0);
  const shippingFee = dto.shippingFee ?? Number(invoice.shippingFee ?? 0);
  const t = sumInvoiceTotals(storedRows, { discount, shipping: shippingFee, isTaxExempt });
  if (differs(t.subtotal, invoice.subtotal) || differs(t.tax, invoice.taxAmount)) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_TAX_STATE_STALE,
      message:
        "This invoice's subtotal or tax no longer matches its lines, so the discount or shipping change can't be priced. Re-save the invoice lines, then try again.",
    });
  }
  return { discount, shippingFee, total: t.total, subtotal: t.subtotal };
}
