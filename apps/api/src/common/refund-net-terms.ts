/**
 * SA-840 (B704 / #1477, B1226): net sales are PRE-tax (`gross = total - taxAmount`), but a refund now returns what the invoice
 * charged, tax included. So the credit terms of net sales take only the NET of a refund off:
 *
 *  - an EXTERNAL_REFUND return nets `creditSubtotal` where the claim froze a split, else `refundAmount` (a row written before
 *    SA-840 is net-only, and a pre-split INLINE row is read as its lump, as before);
 *  - a store-credit refund is a credit note of the GROSS amount, so its return's frozen tax (`creditTax + creditCategoryTax`,
 *    keyed on `refundedAt`) comes off the credit-note term. The bounded edge: a refund within milliseconds of a window
 *    boundary can land its tax in the adjacent period. PR-2 (the CreditNote.taxAmount columns) replaces this read.
 *
 * Every reader (aggregate, per-customer, row-based, sales-facts) calls these, so none restates the rule (L-167).
 */
import { roundMoney } from "@routeflow/pricing";

/** A STANDARD return resolved as store credit that really minted its note (the split is frozen on the Return). */
export const CREDIT_NOTE_RETURN_FILTER = {
  refundMethod: "CREDIT_NOTE",
  kind: "STANDARD",
  creditNoteId: { not: null },
} as const;

/** The two frozen tax columns of a Return. */
export const SPLIT_TAX_SUM = { creditTax: true, creditCategoryTax: true } as const;

interface SplitTax {
  creditTax?: unknown;
  creditCategoryTax?: unknown;
}

/** Regular tax + category tax of a Return (or of an aggregate `_sum` of them), 0 when never split. */
export const splitTax = (r: SplitTax | null | undefined): number =>
  roundMoney(Number(r?.creditTax ?? 0) + Number(r?.creditCategoryTax ?? 0));

/** What an EXTERNAL_REFUND return takes off net sales: the frozen NET where there is one, else the lump. */
export const refundNet = (r: { refundAmount?: unknown; creditSubtotal?: unknown }): number =>
  r.creditSubtotal != null ? Number(r.creditSubtotal) : Number(r.refundAmount ?? 0);

/** `where` of the EXTERNAL_REFUND rows that carry a frozen split (their tax is `refundAmount - creditSubtotal`). */
export const externalSplitWhere = (base: Record<string, unknown>) => ({
  ...base,
  creditSubtotal: { not: null },
});

/** `where` of the store-credit returns whose tax comes off the credit-note term. */
export const noteReturnWhere = (base: Record<string, unknown>) => ({
  ...base,
  ...CREDIT_NOTE_RETURN_FILTER,
});

/** Sum of the frozen tax over the returns `where` matches. */
export async function sumSplitTax(
  db: { return: { aggregate(args: any): Promise<any> } },
  where: Record<string, unknown>,
): Promise<number> {
  const agg = await db.return.aggregate({ where, _sum: SPLIT_TAX_SUM });
  return splitTax(agg?._sum);
}

/** The same, per customer. */
export async function groupSplitTax(
  db: { return: { groupBy(args: any): Promise<any[]> } },
  where: Record<string, unknown>,
): Promise<Map<string, number>> {
  const rows = await db.return.groupBy({ by: ["customerId"], where, _sum: SPLIT_TAX_SUM });
  return new Map(rows.map((r: any) => [r.customerId as string, splitTax(r._sum)]));
}
