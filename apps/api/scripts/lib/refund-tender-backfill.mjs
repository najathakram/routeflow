// Pure decision layer + the writer of apps/api/scripts/backfill-refund-tender.mjs (SA-740r2 item 7). Database-free (the
// writer takes the client), so apps/api/src/common/backfill-refund-tender-script.spec.ts locks every case without Postgres.
//
// A .mjs cannot import the API's TypeScript, so two small things are MIRRORS of apps/api/src/returns/refund-tender.ts and the spec
// pins them equal: the tender -> PaymentMethod map (CARD is CREDIT_CARD) and `setRefundTender`'s updateMany arguments (one
// writer in effect: the same where / data, byte for byte, compared by the spec).

/** Mirror of `refundTenderColumn` (returns/refund-tender.ts): the counter tender -> the PaymentMethod stored. */
export const REFUND_TENDER_COLUMN = { CASH: "CASH", CARD: "CREDIT_CARD", CHECK: "CHECK" };

const isTender = (v) => typeof v === "string" && Object.hasOwn(REFUND_TENDER_COLUMN, v);

/**
 * The backfill plan from candidate rows (a REFUNDED EXTERNAL_REFUND inline return joined to the EARLIEST `inline_return.refund`
 * audit row of THAT return). A row is planned only when:
 *   - the return is REFUNDED, EXTERNAL_REFUND and its column is still null (idempotent reruns plan nothing);
 *   - the audit row's tenantId is NULL (the column is nullable) or EQUALS the return's tenantId (a row of another tenant is
 *     never read as this return's evidence);
 *   - the audit meta's tender is CASH, CARD or CHECK. An unknown or missing tender stays null: NEVER written as CASH.
 */
export function planRefundTenderBackfill(rows) {
  const plan = [];
  const skipped = { notEligible: 0, auditTenantMismatch: 0, unknownTender: 0 };
  for (const r of rows) {
    if (r.status !== "REFUNDED" || r.refundMethod !== "EXTERNAL_REFUND" || r.refundTender != null) {
      skipped.notEligible += 1;
      continue;
    }
    if (r.auditTenantId != null && r.auditTenantId !== r.tenantId) {
      skipped.auditTenantMismatch += 1;
      continue;
    }
    const tender = r.meta && typeof r.meta === "object" ? r.meta.tender : undefined;
    if (!isTender(tender)) {
      skipped.unknownTender += 1;
      continue;
    }
    plan.push({
      returnId: r.returnId,
      tenantId: r.tenantId,
      tender,
      column: REFUND_TENDER_COLUMN[tender],
    });
  }
  return { plan, skipped };
}

/**
 * Row 195 / #3344: splits the plan by the tenants the protected-tenant guard let through. `writableTenants` is the `writable`
 * list of the guard's `filterWritableTenants`; every planned refund of any other tenant is HELD (never written).
 */
export function partitionByWritableTenants(plan, writableTenants) {
  const ok = new Set(writableTenants.map((t) => t.id));
  return {
    apply: plan.filter((p) => ok.has(p.tenantId)),
    held: plan.filter((p) => !ok.has(p.tenantId)),
  };
}

/**
 * Mirror of `setRefundTender` (returns/refund-tender.ts): sets the column of a resolved EXTERNAL_REFUND of this tenant, only
 * where it is still null. Returns the rows written (0 or 1). `db` is a Prisma client (or any `{ return: { updateMany } }`).
 */
export async function setRefundTender(db, { id, tenantId, tender }) {
  if (!isTender(tender)) throw new Error(`refusing to write an unknown tender: ${String(tender)}`);
  const res = await db.return.updateMany({
    where: {
      id,
      tenantId,
      status: "REFUNDED",
      refundMethod: "EXTERNAL_REFUND",
      refundTender: null,
    },
    data: { refundTender: REFUND_TENDER_COLUMN[tender] },
  });
  return res.count;
}
