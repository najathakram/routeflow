// Pure decision layer for apps/api/scripts/backfill-check-dates.mjs (post-dated check
// payments PR-1, additive-only) — kept database-free, mirroring
// scripts/lib/legacy-tenant-backfill.mjs's split, so
// apps/api/src/common/backfill-check-dates-script.spec.ts can lock every case without a live
// Postgres.

/**
 * True iff `row` (a plain InvoicePayment shape) should have its `checkDate` backfilled from
 * `settledAt`. False for:
 *   - a non-CHECK method, or a non-PAID status (status itself is NEVER written by this script —
 *     this predicate reads it, never proposes changing it),
 *   - a row that already carries a `checkDate` (idempotent reruns report 0 changes),
 *   - a `checkStatus` already CLEARED or BOUNCED (the check's post-dated life is over),
 *   - a missing `settledAt`, or one that is not STRICTLY AFTER `sinceInstant` — only a check
 *     still genuinely POST-DATED relative to when this backfill runs is in scope (a settledAt
 *     already in the past predates the post-dated-check feature entirely and needs no
 *     checkDate). See the CLI's own header for why `sinceInstant` defaults to the migration's
 *     own timestamp rather than "now".
 */
export function shouldBackfillCheckDate(row, sinceInstant) {
  if (row.method !== "CHECK") return false;
  if (row.status !== "PAID") return false;
  if (row.checkDate != null) return false;
  if (row.checkStatus === "CLEARED" || row.checkStatus === "BOUNCED") return false;
  if (!row.settledAt) return false;
  const settled = row.settledAt instanceof Date ? row.settledAt : new Date(row.settledAt);
  const since = sinceInstant instanceof Date ? sinceInstant : new Date(sinceInstant);
  if (Number.isNaN(settled.getTime()) || Number.isNaN(since.getTime())) return false;
  return settled.getTime() > since.getTime();
}

/**
 * UTC calendar-day truncation of `settledAt`, for writing into the `@db.Date` `checkDate`
 * column — "checkDate = settledAt::date", always in UTC so the script's output does not depend
 * on the host machine's local timezone.
 */
export function deriveCheckDate(settledAt) {
  const d = settledAt instanceof Date ? settledAt : new Date(settledAt);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Filters `rows` down to the ones `shouldBackfillCheckDate` accepts and maps each to the write
 * this script would perform. Never mutates `rows`, and the output objects carry no `status`
 * field at all — proof by construction that this plan can never propose a status change.
 */
export function planCheckDateBackfill(rows, sinceInstant) {
  return rows
    .filter((row) => shouldBackfillCheckDate(row, sinceInstant))
    .map((row) => ({
      id: row.id,
      tenantId: row.tenantId ?? null,
      invoiceId: row.invoiceId,
      settledAt: row.settledAt,
      checkDate: deriveCheckDate(row.settledAt),
    }));
}
