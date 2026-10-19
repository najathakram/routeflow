import type { Prisma } from "@prisma/client";
import type { PlanCatalogService, PlanVersionWithCatalog } from "./plan-catalog.service";

/**
 * SA-815a (G1c-1) - the plan-version pin: ONE writer and ONE resolver.
 *
 * A tenant's catalog version is pinned in TWO places, and the writers used to diverge (plan moves wrote
 * `Tenant.planVersionId`, the scheduled downgrade wrote `TenantSubscription.planVersionId`, a manual activation wrote
 * only the subscription's), so a tenant's entitlements read one version while the cron and the invariant job read
 * another.
 *
 * Ruling: `TenantSubscription.planVersionId` is the SOURCE OF TRUTH (the billing record, next to `planKey`);
 * `Tenant.planVersionId` is a MIRROR of it (it retires later, census first).
 *
 *  - {@link pinPlanVersionTx} is the ONLY code that writes either column, always both, in the caller's transaction.
 *    `plan-version-pin.pin.spec.ts` fails the build for any other write.
 *  - {@link resolvePlanVersionId} / {@link inclusionCatalogFor} are the ONLY way to answer "which catalog version
 *    does this tenant sit on": the subscription's pin, else the tenant's, else the published version. Every
 *    add-on inclusion judgment and the entitlement resolver read through them.
 */

/** Who pinned, for the caller's own record. Optional: the pin itself writes no BillingEvent (the lists stay exact). */
export interface PlanPinActor {
  kind: "TENANT_USER" | "PLATFORM_ADMIN" | "SYSTEM";
  id: string | null;
  source: string;
}

/**
 * Write BOTH pins to `planVersionId` inside `tx`. The caller holds the Tenant row lock. The subscription is updated
 * with `updateMany` because a tenant that has never subscribed has no row yet (then only the tenant pin moves, and the
 * subscription write that creates the row carries no pin of its own: call this AFTER it).
 */
export async function pinPlanVersionTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  planVersionId: string,
  _actor?: PlanPinActor,
): Promise<void> {
  await tx.tenantSubscription.updateMany({ where: { tenantId }, data: { planVersionId } });
  await tx.tenant.updateMany({ where: { id: tenantId }, data: { planVersionId } });
}

/** The version id a tenant is pinned to: the subscription's pin, else the tenant's, else null (= the published one). */
export function resolvePlanVersionId(
  sub?: { planVersionId?: string | null } | null,
  tenant?: { planVersionId?: string | null } | null,
): string | null {
  return sub?.planVersionId ?? tenant?.planVersionId ?? null;
}

/**
 * The catalog an add-on inclusion judgment on this tenant must read: its pinned version (`sub.planVersionId ??
 * tenant.planVersionId`), else the published one. `published` is the PUBLISHED version the caller already holds; it is reused
 * (no extra read) when the tenant is unpinned or pinned to it.
 */
export async function inclusionCatalogFor(
  catalog: Pick<PlanCatalogService, "getVersionForTenant">,
  sub?: { planVersionId?: string | null } | null,
  tenant?: { planVersionId?: string | null } | null,
  published?: PlanVersionWithCatalog | null,
): Promise<PlanVersionWithCatalog> {
  const id = resolvePlanVersionId(sub, tenant);
  if (published && (!id || published.id === id)) return published;
  return catalog.getVersionForTenant(id);
}
