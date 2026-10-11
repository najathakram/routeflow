/**
 * SA-773: the refund paths' one call into the refundable remainder. Each runs INSIDE the claim transaction, after the row locks
 * the path already holds (Return, Order, source invoices) and BEFORE its claim: a refund that would give back more than the
 * goods' remainder is 409 RETURN_EXCEEDS_REFUNDABLE { invoiceId, productId?, remainingQty, remainingValue } and nothing is
 * written. This module takes no lock of its own beyond the order's other creditable invoices, which the inline path adds so the
 * whole pool is held (the STANDARD claim already locks them all).
 */
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";
import { lockRefundInvoices } from "./inline-return-refund";
import { roundMoney } from "@routeflow/pricing";
import {
  assertWithinRefundable,
  creditNoteRequests,
  creditableGroupInvoiceIds,
  inlineReturnRequests,
  type InlineSourceRef,
  refundableRefusal,
  refundableRemainder,
  resolveInlineSourceInvoices,
  selectedGoodsRemainder,
  standardReturnRequests,
} from "./refundable-remainder";
import type { ProductPackBasis } from "./returns-restock-pieces";

/** An INLINE return (a capture, a refund, or store credit instead): its items against the pools of its source invoices. */
export async function assertInlineReturnWithinRemainder(
  tx: any,
  tenantId: string | null,
  args: {
    /** the return being refunded; absent for a capture (its return does not exist yet) */
    returnId?: string;
    /** the invoices the returned lines sit on (already locked by the caller); resolved from the items' source lines when absent */
    invoiceIds?: readonly string[];
    items: Parameters<typeof inlineReturnRequests>[1];
    /** the caller has NOT locked the source invoices (approve): lock the whole pool here, after the Orders it holds */
    lockSourceInvoices?: boolean;
  },
): Promise<void> {
  const invoiceIds =
    args.invoiceIds ??
    [
      ...new Set(
        (await resolveInlineSourceInvoices(tx, args.items))
          .map((r) => r.invoiceId)
          .filter((i): i is string => !!i),
      ),
    ].sort();
  if (invoiceIds.length === 0) return;
  // The pool is the order's whole creditable set: lock the siblings the source lines did not name. Taking them AFTER the source
  // invoices is safe only because every locker of several invoices of one order takes the ORDER first (the caller holds it), so
  // two value-givers on the pool queue on the Order and the id order across the two statements cannot cycle.
  const group = await creditableGroupInvoiceIds(tx, invoiceIds);
  if (args.lockSourceInvoices || group.some((id) => !invoiceIds.includes(id)))
    await lockRefundInvoices(tx, tenantId, group);
  const rem = await refundableRemainder(tx, { invoiceIds: group, excludeReturnId: args.returnId });
  assertWithinRefundable(
    rem,
    await inlineReturnRequests(tx, args.items),
    API_ERROR_CODES.RETURN_EXCEEDS_REFUNDABLE,
  );
}

/**
 * SA-773 N4: a captured inline return is approved, converted to store credit or re-issued some time after it was captured, and
 * its source can have changed in between. A dead (VOID / WRITTEN_OFF) invoice has no pool in the refundable remainder (it is
 * not in the creditable set), so a request on it was never checked and the mint gave store credit for goods nobody owes for.
 * Refused 409 RETURN_NOTHING_BILLED before anything is restocked, reversed or minted; the exit is rejecting or cancelling the
 * return. The invoice is the one the item's goods sit on NOW (`resolveInlineSourceInvoices`): the stored source line id, or,
 * when a rebuild of the order's invoice lines gave the invoice new line ids (any staff edit of the order after delivery), the
 * live line carrying the same order line. Only when NOTHING resolves (the order line was deleted, or its invoice line is gone)
 * does it fail closed with the same code: there is then no invoice to be owed on. A rotated line on a voided sale is dead.
 * Runs under the Orders and the source invoices the caller holds, so a void cannot slip in after it. An item with NO source
 * line id (unreferenced) has no source to be dead and is not asked about here: its own hold and the paid-in-full check own it.
 */
export async function assertInlineSourcesOpen(
  tx: any,
  items: ReadonlyArray<InlineSourceRef>,
): Promise<void> {
  if (!items.some((i) => i.sourceInvoiceItemId)) return;
  const where = await resolveInlineSourceInvoices(tx, items);
  if (where.some((w) => w.missing)) {
    throw new ConflictException({
      code: API_ERROR_CODES.RETURN_NOTHING_BILLED,
      message:
        "The invoice line these goods were sold on no longer exists (the sale was edited after the return was captured), so there is nothing to credit for them. Cancel the return and capture it again.",
    });
  }
  const invoiceIds = [
    ...new Set(where.map((w) => w.invoiceId).filter((i): i is string => !!i)),
  ].sort();
  if (invoiceIds.length === 0) return;
  const dead: { id: string } | null = await tx.invoice.findFirst({
    where: { id: { in: invoiceIds }, status: { in: [...CREDIT_SOURCE_EXCLUDED] } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (!dead) return;
  throw new ConflictException({
    code: API_ERROR_CODES.RETURN_NOTHING_BILLED,
    message:
      "The invoice these goods were sold on was voided or written off after the return was captured, so there is nothing to credit for them. Reject or cancel the return.",
    invoiceId: dead.id,
  });
}

/** A STANDARD return's refund (store credit or recorded): its qty per product and its net amount, on the order's invoices. */
export async function assertStandardRefundWithinRemainder(
  tx: any,
  args: {
    returnId: string;
    /** the order's creditable invoices, all locked by the claim */
    invoiceIds: readonly string[];
    items: ReadonlyArray<{ productId: string; qty: unknown }>;
    bases: Map<string, ProductPackBasis>;
    amount: number;
  },
): Promise<void> {
  if (args.invoiceIds.length === 0) return;
  const rem = await refundableRemainder(tx, {
    invoiceIds: args.invoiceIds,
    excludeReturnId: args.returnId,
  });
  assertWithinRefundable(
    rem,
    standardReturnRequests(rem, args.invoiceIds, args.items, args.bases, args.amount),
    API_ERROR_CODES.RETURN_EXCEEDS_REFUNDABLE,
  );
}

/**
 * A standalone credit note (create, or the replacement of a reissue): its items' pieces and gross value, or its amount alone, on
 * the invoice's pool. Runs inside the credit note's own transaction after the invoice lock (and, with 2+ creditable invoices, the
 * order pool locks) `create()` takes. `excludeCreditNoteId` leaves out the note a dry run replaces.
 */
export async function assertCreditWithinRemainder(
  tx: any,
  args: {
    invoiceId: string;
    amount: number;
    items: ReadonlyArray<{
      invoiceItemId: string;
      amount: number;
      qty: number;
      categoryTax?: number;
    }>;
    excludeCreditNoteId?: string;
  },
): Promise<void> {
  const rem = await refundableRemainder(tx, {
    invoiceIds: [args.invoiceId],
    excludeCreditNoteId: args.excludeCreditNoteId,
  });
  assertWithinRefundable(
    rem,
    await creditNoteRequests(tx, args),
    API_ERROR_CODES.CREDIT_EXCEEDS_REFUNDABLE,
  );
}

/**
 * The PREVIEW of a STANDARD return's refund (display only, no lock, never a gate): the priced figure, or - when the claim would
 * refuse it for the remainder - what the selected goods still have left. `capped: true` MEANS THE CLAIM WILL REFUSE this return
 * (409 RETURN_EXCEEDS_REFUNDABLE): a STANDARD refund has no amount input, it is always priced at the pool average, so the
 * capped figure is information ("up to $X is left"), never an amount that can be refunded. Callers must present it as a block,
 * not as an offer. The claim itself is never clamped.
 */
export async function previewStandardRefund(
  db: any,
  args: {
    returnId: string;
    invoiceIds: readonly string[];
    items: ReadonlyArray<{ productId: string; qty: unknown }>;
    bases: Map<string, ProductPackBasis>;
    amount: number;
  },
): Promise<{ amount: number; capped: boolean }> {
  if (args.invoiceIds.length === 0 || !(args.amount > 0))
    return { amount: args.amount, capped: false };
  const rem = await refundableRemainder(db, {
    invoiceIds: args.invoiceIds,
    excludeReturnId: args.returnId,
  });
  const requests = standardReturnRequests(
    rem,
    args.invoiceIds,
    args.items,
    args.bases,
    args.amount,
  );
  if (!refundableRefusal(rem, requests)) return { amount: args.amount, capped: false };
  // ONE basis: the net a STANDARD refund pays out (the estimate is net), so "up to $X" and the estimate are comparable
  const left = selectedGoodsRemainder(
    rem,
    requests
      .filter((r) => r.productId)
      .map((r) => ({ invoiceId: r.invoiceId, productId: r.productId as string })),
    "net",
  );
  return { amount: roundMoney(Math.min(args.amount, left)), capped: true };
}
