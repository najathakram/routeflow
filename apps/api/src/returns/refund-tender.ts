/**
 * SA-740r/r2: the refund tender column (`Return.refundTender`, the existing `PaymentMethod` enum) and its vocabulary.
 *
 * The counter names a refund tender CASH | CARD | CHECK; the column stores the PaymentMethod (CARD -> CREDIT_CARD). Both
 * directions go through ONE pair of functions built on `toPrismaMethod` (the map the counter payment legs use), so a write,
 * a replay comparison, a response and the drawer fold can never disagree. A column that holds anything else (or null) is
 * UNKNOWN: it is never read as CASH.
 */
import { toPrismaMethod } from "../orders/counter-sale/counter-sale-payment";
import { REFUND_TENDERS, type RefundTender } from "./inline-return-refund";

/** The PaymentMethod values a counter refund tender maps to. */
export type RefundTenderColumn = "CASH" | "CREDIT_CARD" | "CHECK";

const isRefundTender = (v: unknown): v is RefundTender =>
  typeof v === "string" && (REFUND_TENDERS as readonly string[]).includes(v);

/** The column value of a tender (CARD -> CREDIT_CARD), via the counter payment map. */
export function refundTenderColumn(tender: RefundTender): RefundTenderColumn {
  const column = toPrismaMethod(tender);
  if (column == null) throw new Error(`not a refund tender: ${String(tender)}`);
  return column;
}

/** The tender a stored column value stands for; anything else (null, ACH, ZELLE, ...) is unknown (null), never CASH. */
export function refundTenderOfColumn(column: string | null | undefined): RefundTender | null {
  return REFUND_TENDERS.find((t) => refundTenderColumn(t) === column) ?? null;
}

/**
 * The tender of a stored return: the COLUMN first; only a row the backfill has not reached (column null) falls back to the
 * `inline_return.refund` audit meta's tender, and only when it is a real tender. Unknown otherwise.
 */
export function refundTenderOfReturn(
  ret: { refundTender?: string | null },
  auditMeta?: { tender?: unknown } | null,
): RefundTender | null {
  const fromColumn = refundTenderOfColumn(ret.refundTender);
  if (fromColumn) return fromColumn;
  return isRefundTender(auditMeta?.tender) ? auditMeta.tender : null;
}

/** The CAS `data` fragment of a refund claim: the column value, or null when no tender was given (tenderKnown false). */
export function refundTenderData(tender: RefundTender | null | undefined): {
  refundTender: RefundTenderColumn | null;
} {
  return { refundTender: tender ? refundTenderColumn(tender) : null };
}

/**
 * THE writer for a tender AFTER the fact (the backfill): sets the column of a resolved EXTERNAL_REFUND of this tenant, only
 * where it is still null, so it is idempotent and can never overwrite a recorded tender. Returns the rows written (0 or 1).
 * No second SQL writer exists: the claims write the column in their own CAS data (`refundTenderData`).
 */
export async function setRefundTender(
  db: { return: { updateMany: (args: any) => Promise<{ count: number }> } },
  input: { id: string; tenantId: string; tender: RefundTender },
): Promise<number> {
  if (!isRefundTender(input.tender))
    throw new Error(`refusing to write an unknown tender: ${String(input.tender)}`);
  const res = await db.return.updateMany({
    where: {
      id: input.id,
      tenantId: input.tenantId,
      status: "REFUNDED",
      refundMethod: "EXTERNAL_REFUND",
      refundTender: null,
    },
    data: { refundTender: refundTenderColumn(input.tender) },
  });
  return res.count;
}
