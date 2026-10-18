import { BadRequestException, ConflictException, Logger, NotFoundException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { sumConfirmed } from "./payment-predicates";
import {
  assertTaxStateRecomputable,
  staleTaxStateError,
  TAX_STATE_STALE_MESSAGES,
} from "./stored-tax-state";

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
  /** Its payment rows (amount + status), read under the lock for the B1046 overpayment guard. */
  payments: Array<{ amount: unknown; status: unknown }>;
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
export async function loadLockedInvoiceForEdit(
  tx: any,
  id: string,
  /** H4: the editor's token, checked against the LOCKED row before the lines are read (assertInvoiceCurrent). */
  expectedUpdatedAt?: string,
  onMissingToken?: () => void,
): Promise<LockedInvoiceForEdit> {
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
  assertInvoiceCurrent(invoice, expectedUpdatedAt, onMissingToken);
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
  const payments = await tx.invoicePayment.findMany({
    where: { invoiceId: id },
    select: { amount: true, status: true },
  });
  return { invoice, storedRows, isTaxExempt: !!customer?.isTaxExempt, payments: payments ?? [] };
}

/**
 * Review hardening: the pre-lock read named an order; the lock was taken on the order the invoice points at NOW.
 * If the link moved in between, the carrier check, ledger resync and order recompute would act on a stale order.
 */
export function assertSameOrderLink(
  locked: { orderId?: string | null },
  pre: { orderId?: string | null },
): void {
  if ((locked.orderId ?? null) !== (pre.orderId ?? null)) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
      message: "The invoice changed while it was being edited. Try again.",
    });
  }
}

/**
 * H4: the editor's `expectedUpdatedAt` must equal the LOCKED invoice's updatedAt, else 409 INVOICE_STALE and
 * nothing is written (a second editor replaying an old form deleted the first editor's changes). Absent = a
 * legacy client: accepted for one release, reported through `onMissing` (a warn log) so it can be made required.
 */
export function assertInvoiceCurrent(
  invoice: { id?: string; updatedAt?: Date | string | null },
  expected: string | null | undefined,
  onMissing?: () => void,
): void {
  if (expected == null) {
    onMissing?.();
    return;
  }
  const current = invoice.updatedAt ? new Date(invoice.updatedAt).getTime() : NaN;
  if (new Date(expected).getTime() !== current) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_STALE,
      message:
        "This invoice was changed by someone else since you opened it. Reload to see the latest, then re-apply your changes.",
    });
  }
}

/** H4: its own channel, so the count of token-less invoice saves is one grep before the token is required. */
const staleTokenLogger = new Logger("InvoiceStaleToken");
export const noTokenWarner = (id: string) => () =>
  staleTokenLogger.warn(
    `PATCH /invoices/${id} without expectedUpdatedAt (H4: last-writer save accepted)`,
  );

/**
 * H4: the header-only save that touches no totals. Without a token it stays one unlocked update (legacy);
 * with one, the Invoice row is locked and the token checked first, so a stale editor writes nothing.
 */
export async function updateHeaderOnly(
  prisma: { forTenant(): any; tenantTransaction(fn: (tx: any) => Promise<any>): Promise<any> },
  id: string,
  { expectedUpdatedAt }: { expectedUpdatedAt?: string },
  data: any,
  include: any,
  onMissingToken: () => void,
) {
  if (expectedUpdatedAt == null) {
    onMissingToken();
    return prisma.forTenant().invoice.update({ where: { id }, data, include });
  }
  return prisma.tenantTransaction(async (tx: any) => {
    await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.invoice.findUnique({
      where: { id },
      select: { id: true, updatedAt: true, status: true },
    });
    if (!cur) throw new NotFoundException("Invoice not found");
    assertInvoiceCurrent(cur, expectedUpdatedAt);
    assertStillDraft(cur);
    return tx.invoice.update({ where: { id }, data, include });
  });
}

/** r87: the unlocked pre-read said DRAFT; the lock says whether it still is (a send can commit in between). */
export function assertStillDraft(invoice: { status?: unknown }): void {
  if (invoice.status !== InvoiceStatus.DRAFT) {
    throw new BadRequestException("Only DRAFT invoices can be edited");
  }
}

/** The two header money fields rounded to cents at intake (B1047): 10.005 must not store as 10.00 while the total counts 10.01. */
export const intakeMoney = (v: number | null | undefined, stored: unknown): number =>
  v != null ? roundMoney(v) : Number(stored ?? 0);

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
 *
 * Known edges, ruled by the Lead (INV-A review):
 *  - An EXEMPT customer whose row still carries a levy snapshot (categoryTaxAmount != 0) is stale even when
 *    the stored tax is 0: the items branch would zero the snapshot and resync the regulated ledger, this
 *    branch cannot, so the two must not disagree. Re-saving the lines cleans both (census reason 4).
 *  - B296: create() taxes with the UNROUNDED line rate while InvoiceItem.taxRate is Decimal(5,4), so a fresh
 *    draft with a rate such as 0.08875 can be 409 INVOICE_TAX_STATE_STALE on its first header-only PATCH.
 *    That is a 409 (re-save the lines), never a silent re-tax. Do NOT round the rate in create(): it would
 *    change the money charged. SA-761 T-1 (sitting 4) widens InvoiceItem.taxRate and retires this edge.
 */
export function planHeaderOnlyTotals(
  locked: LockedInvoiceForEdit,
  dto: { discount?: number; shippingFee?: number },
): { discount: number; shippingFee: number; total: number; subtotal: number } {
  const { invoice, storedRows, isTaxExempt } = locked;
  const discount = intakeMoney(dto.discount, invoice.discount);
  const shippingFee = intakeMoney(dto.shippingFee, invoice.shippingFee);
  // SA-814 R5-2: the tax half is the ONE recompute guard (stored-tax-state.ts); this path cannot stamp a rate.
  const t = assertTaxStateRecomputable({
    invoice,
    storedLines: storedRows,
    canRestamp: false,
    isTaxExempt,
    refuseExemptLevy: true,
    discount,
    shipping: shippingFee,
    message: TAX_STATE_STALE_MESSAGES.header,
  }).totals;
  if (differs(t.subtotal, invoice.subtotal)) {
    throw staleTaxStateError(TAX_STATE_STALE_MESSAGES.header);
  }
  return { discount, shippingFee, total: t.total, subtotal: t.subtotal };
}

/**
 * B1046: an edit must not take a DRAFT's total below what is already paid or credited against it
 * (CONFIRMED payments, the basis the status recompute uses). NOT-WORSE (like assertInvoiceTotalsSane): an
 * invoice that is ALREADY overpaid may still be saved while the edit does not deepen the overpayment.
 */
export function assertNotOverpaidByEdit(
  payments: ReadonlyArray<{ amount: unknown; status: unknown }> | null | undefined,
  newTotal: number,
  storedTotal: unknown,
): void {
  const paid = roundMoney(sumConfirmed(payments as any));
  if (paid <= 0) return;
  const over = (total: number) => Math.max(0, roundMoney(paid - roundMoney(total)));
  if (over(newTotal) > over(Number(storedTotal))) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_TOTAL_BELOW_PAID,
      message: `This change would take the invoice total ($${roundMoney(newTotal).toFixed(2)}) below the $${paid.toFixed(2)} already paid or credited. Remove the credit first, or change the lines or discount.`,
    });
  }
}
