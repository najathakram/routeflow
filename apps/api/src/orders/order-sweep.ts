/**
 * B323 / SA-776 / B776: the hourly + boot-time pending-order sweep — lifted VERBATIM out of `OrdersService`
 * (size-ratchet prefactor: orders.service.ts sits at its cap and the next lanes add call sites to it). No
 * behaviour change: the body is token-identical to the method it replaces except `this.` -> `self.` (the
 * instance is passed explicitly); the class keeps a thin same-signature delegator, so no call site and no spec
 * changes (mirrors order-lifecycle.ts).
 */

import { OrderStatus } from "@prisma/client";
import { isMergeContention } from "./merge-contention";
import { openTenantGroups } from "./sweep-tenant-gate";
import type { OrdersService } from "./orders.service";

export async function sweepAllPendingOrdersImpl(self: OrdersService): Promise<{
  customers: number;
  merged: number;
  skipped: number;
  /** B776: customers whose merge folded 2+ disagreeing packs for a product this sweep run. */
  packMismatches: number;
  /** SA-124: customers whose merge resolved a box-unaware, no-snapshot contribution via the
   * live product pack this sweep run (SA-101(a) branch 4) — independent of packMismatches. */
  livePackFallbacks: number;
}> {
  // B323: no HTTP request context runs this (cron tick / boot), so ALS is empty and
  // forTenant() used to fall through to the UNSCOPED client — every forTenant() call
  // deeper in mergeAllPendingForCustomer (SystemConfigService.get for the tax rate,
  // product lookups, ...) then resolved against whichever tenant's row a bare
  // findFirst/findMany happened to return first, not the customer's own tenant.
  // Group by tenantId alongside customerId so each group carries the tenant to
  // re-enter below.
  const pendingMergeCandidateWhere = {
    status: OrderStatus.PENDING,
    routeRunId: null,
    routeRunStopId: null,
    transaction: { is: null },
    invoices: { none: {} },
    returns: { none: {} },
    skipAutoMerge: false,
  };

  const groups = await self.prisma.forTenant().order.groupBy({
    by: ["customerId", "tenantId"],
    where: pendingMergeCandidateWhere,
    _count: { _all: true },
    having: { customerId: { _count: { gt: 1 } } },
  });

  // F1 (B323 review): a customer with, say, one pending order under a real tenant AND
  // one legacy null-tenant order lands in two SEPARATE one-row (customerId, tenantId)
  // groups above — neither clears `having customerId._count > 1`, so the pair was
  // silently invisible to both the merge loop AND the warn below it. Run one extra
  // query on the same (unscoped, deliberate) client, over the identical filter but
  // restricted to tenantId: null, so every customer with a null-tenant pending order
  // is found and counted whether or not their real-tenant group individually cleared
  // the >1 threshold.
  const nullTenantRows = await self.prisma.forTenant().order.groupBy({
    by: ["customerId"],
    where: { ...pendingMergeCandidateWhere, tenantId: null },
    _count: { _all: true },
  });
  for (const r of nullTenantRows) {
    self.logger.warn(
      `sweepAllPendingOrders: customer ${r.customerId} has ${r._count._all} pending order(s) without tenantId — not merged (B323)`,
    );
  }
  const skipped = nullTenantRows.length;

  // Null-tenant groups are counted + warned above (never double-logged); SA-776: a tenant that is not
  // TRIAL / ACTIVE gets no automated merge (sweep-tenant-gate.ts), so `customers` counts only eligible groups.
  const mergeCandidateGroups = await openTenantGroups(self.prisma, groups);

  let merged = 0;
  let packMismatches = 0;
  let livePackFallbacks = 0;
  for (const g of mergeCandidateGroups) {
    try {
      // RF-008: re-enter this group's OWN tenant's ALS scope before calling into
      // anything that relies on ambient forTenant() scoping (same pattern as
      // recurring-invoices.generateDueRecurringInvoices / tobacco-report /
      // order-templates / authorization-expiry / commission-reconciliation /
      // regulated-filing-cron).
      const winner = await self.tenantCtx.run(g.tenantId as string, () =>
        self.mergeAllPendingForCustomer(
          g.customerId,
          {},
          {
            onPackMismatch: () => packMismatches++,
            onLivePackFallback: () => livePackFallbacks++,
          },
        ),
      );
      if (winner) merged++;
    } catch (e) {
      // Skip by CAUSE, not by exception type: only the two coded lock-contention errors mean
      // "someone else holds this customer's lock, try again next hour". A 409/503 raised for
      // any OTHER reason inside the merge (a credit-limit conflict, a genuinely dead
      // dependency) is a real fault and must still stop the sweep — swallowing it by type
      // would hide a broken merge behind an hourly "skipped" line forever.
      if (isMergeContention(e)) {
        self.logger.warn(
          `sweepAllPendingOrders: skipped customer ${g.customerId} — ${(e as Error)?.message ?? e}`,
        );
        continue;
      }
      throw e;
    }
  }
  self.logger.log(
    `sweepAllPendingOrders: swept ${mergeCandidateGroups.length} customer(s), merged into ${merged} winner(s), skipped ${skipped} without tenantId, ${packMismatches} pack mismatch(es), ${livePackFallbacks} live-pack fallback(s) (B776)`,
  );
  return {
    customers: mergeCandidateGroups.length,
    merged,
    skipped,
    packMismatches,
    livePackFallbacks,
  };
}
