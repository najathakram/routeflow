/**
 * SA-773: the refund paths' one call into the refundable remainder. Each runs INSIDE the claim transaction, after the row locks
 * the path already holds (Return, Order, source invoices) and BEFORE its claim: a refund that would give back more than the
 * goods' remainder is 409 RETURN_EXCEEDS_REFUNDABLE { invoiceId, productId?, remainingQty, remainingValue } and nothing is
 * written. This module takes no lock of its own beyond the order's other creditable invoices, which the inline path adds so the
 * whole pool is held (the STANDARD claim already locks them all).
 */
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockRefundInvoices } from "./inline-return-refund";
import {
  assertWithinRefundable,
  creditableGroupInvoiceIds,
  inlineReturnRequests,
  refundableRemainder,
  standardReturnRequests,
} from "./refundable-remainder";
import type { ProductPackBasis } from "./returns-restock-pieces";

/** An INLINE return (refund or store credit instead): its stored items against the pools of its source invoices. */
export async function assertInlineReturnWithinRemainder(
  tx: any,
  tenantId: string | null,
  args: {
    returnId: string;
    /** the invoices the returned lines sit on (already locked by the caller) */
    invoiceIds: readonly string[];
    items: Parameters<typeof inlineReturnRequests>[1];
  },
): Promise<void> {
  if (args.invoiceIds.length === 0) return;
  // the pool is the order's whole creditable set: lock the siblings the source lines did not name (Order is already held)
  const group = await creditableGroupInvoiceIds(tx, args.invoiceIds);
  if (group.some((id) => !args.invoiceIds.includes(id)))
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
