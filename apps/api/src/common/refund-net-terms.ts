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

/**
 * A return resolved as store credit that really minted its note (the split is frozen on the Return). Standard and inline
 * returns both mint the note for the GROSS amount, so the filter never keys on the return's kind (SA-980): every writer
 * that links a note to a Return stores `refundMethod` CREDIT_NOTE with it. It keys on `status` REFUNDED too: an inline
 * cancel voids the note but leaves `refundMethod`, `creditNoteId` and the frozen tax on the row, and a voided note is
 * no longer in the credit-note term, so a CANCELLED row must not give its tax back.
 */
export const CREDIT_NOTE_RETURN_FILTER = {
  status: "REFUNDED",
  refundMethod: "CREDIT_NOTE",
  creditNoteId: { not: null },
} as const;

/** The two frozen tax columns of a Return. */
export const SPLIT_TAX_SUM = { creditTax: true, creditCategoryTax: true } as const;

export interface SplitTax {
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

/** The `where` of a Return read: the filters above spread onto a tenant/window base. */
type ReturnWhere = Record<string, unknown>;

/** The slice of the db client the two readers use (structural, like AccrualSalesDb: the real client is richer). */
export interface SplitTaxAggregateDb {
  return: {
    aggregate(args: {
      where: ReturnWhere;
      _sum: typeof SPLIT_TAX_SUM;
    }): Promise<{ _sum?: SplitTax | null } | null>;
  };
}
export interface SplitTaxGroupByDb {
  return: {
    groupBy(args: {
      by: ["customerId"];
      where: ReturnWhere;
      _sum: typeof SPLIT_TAX_SUM;
    }): Promise<Array<{ customerId: string; _sum?: SplitTax | null }>>;
  };
}

/** Sum of the frozen tax over the returns `where` matches. */
export async function sumSplitTax(db: SplitTaxAggregateDb, where: ReturnWhere): Promise<number> {
  const agg = await db.return.aggregate({ where, _sum: SPLIT_TAX_SUM });
  return splitTax(agg?._sum);
}

/** The same, per customer. */
export async function groupSplitTax(
  db: SplitTaxGroupByDb,
  where: ReturnWhere,
): Promise<Map<string, number>> {
  const rows = await db.return.groupBy({ by: ["customerId"], where, _sum: SPLIT_TAX_SUM });
  return new Map(rows.map((r) => [r.customerId, splitTax(r._sum)]));
}
