import { lockTenantForLedger } from "./addon-ledger";
import type { DunningDeps } from "./dunning-core";

/**
 * The ONE clock writer (SA-733r7 PR-B3): `invoice.payment_failed` and the daily discovery sweep both stamp through
 * here. Under the Tenant lock, a CAS on `pastDueInvoiceId IS NULL` and no catch-up claim: the OLDER clock wins, a
 * replay of the same invoice finds the clock already set, and a held catch-up claim is never stamped. Returns true
 * when THIS call wrote the clock.
 */
export async function stampClock(
  deps: Pick<DunningDeps, "prisma">,
  tenantId: string,
  invoiceId: string,
  since: Date,
): Promise<boolean> {
  return deps.prisma.$transaction(async (tx) => {
    await lockTenantForLedger(tx, tenantId);
    const r = await tx.tenantSubscription.updateMany({
      where: { tenantId, pastDueInvoiceId: null, catchupState: null },
      data: { pastDueSince: since, pastDueInvoiceId: invoiceId },
    });
    return r.count === 1;
  });
}
