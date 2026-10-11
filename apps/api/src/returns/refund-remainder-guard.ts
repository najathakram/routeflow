/**
 * SA-773: the refund paths' one call into the refundable remainder. Each runs INSIDE the claim transaction, after the row locks
 * the path already holds (Return, Order, source invoices) and BEFORE its claim: a refund that would give back more than the
 * goods' remainder is 409 RETURN_EXCEEDS_REFUNDABLE { invoiceId, productId?, remainingQty, remainingValue } and nothing is
 * written. This module takes no lock of its own beyond the order's other creditable invoices, which the inline path adds so the
 * whole pool is held (the STANDARD claim already locks them all).
 */
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockRefundInvoices, resolveRefundInvoiceIds } from "./inline-return-refund";
import { roundMoney } from "@routeflow/pricing";
import {
  assertWithinRefundable,
  creditNoteRequests,
  creditableGroupInvoiceIds,
  inlineReturnRequests,
  refundableRefusal,
  refundableRemainder,
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
    (
      await resolveRefundInvoiceIds(tx, {
        kind: "LINES",
        sourceInvoiceItemIds: args.items.map((i) => i.sourceInvoiceItemId),
      })
    ).invoiceIds;
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
 * refuse it for the remainder - what the selected goods still have left, so the screen never offers a figure the claim then
 * refuses. `capped` says which. The claim itself is never clamped: it refuses (409 RETURN_EXCEEDS_REFUNDABLE).
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
  const left = selectedGoodsRemainder(
    rem,
    requests
      .filter((r) => r.productId)
      .map((r) => ({ invoiceId: r.invoiceId, productId: r.productId as string })),
  );
  return { amount: roundMoney(Math.min(args.amount, left)), capped: true };
}
