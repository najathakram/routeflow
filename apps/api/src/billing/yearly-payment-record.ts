import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * The paid-yearly record every staff-refund route reads (SA-1297 ruling 2, co-signed with changes C1-C3 by SA-A).
 * `amount` is the provider invoice's amount_paid as a decimal string, already through `roundMoney` (never recomputed);
 * `paidAt` is the invoice's own paid timestamp, not the webhook receipt time.
 */
export interface YearlyPaymentRecord {
  invoiceId: string;
  amount: string;
  currency: string;
  paidAt: Date;
  periodStart: Date;
  periodEnd: Date;
  planKey: string;
}

/** A client or a transaction: the reader works on either, so the staff refund reads it under its tenant lock. */
export type YearlyPaymentDb =
  Pick<Prisma.TransactionClient, "billingEvent"> | Pick<PrismaService, "billingEvent">;

/**
 * The tenant's latest paid yearly payment, or null when there is none. Looks up by `tenantId` only.
 *
 * STUB, until SA-1304 PR-4 lands (R-2 may land first, behind this null body). PR-4 replaces the body and adds the writer
 * (`recordYearlyPayment`, its own $transaction under lockTenantForLedger, one `invoice.yearly_paid` row per provider invoice id).
 * Contract PR-4 must keep (SA-A co-sign C1-C3):
 *   - C2: only `billing_reason` subscription_create or subscription_cycle on a year-interval subscription line, so a
 *     subscription_update proration invoice can never be the record a staff refund copies;
 *   - C3: order by `createdAt desc`, then `id desc`; `amount` is the invoice's `amount_paid`.
 * Until then every staff-refund route answers STAFF_REFUND_NO_YEARLY_PAYMENT.
 */
export function latestYearlyPayment(
  _db: YearlyPaymentDb,
  _tenantId: string,
): Promise<YearlyPaymentRecord | null> {
  return Promise.resolve(null);
}
