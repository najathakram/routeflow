import type { PrismaService } from "../prisma/prisma.service";
import { acceptsAutomatedWrites } from "../tenant/tenant-automation";

/**
 * SA-776 (row 382): the pending-order sweep (hourly cron + the boot run) MERGES and DELETES PENDING orders, so it is
 * a TRANSACTIONAL job: a tenant that is not TRIAL / ACTIVE (READ_ONLY, SUSPENDED, CANCELLED) gets no automated merge.
 * Kept out of `orders.service.ts` (its size ratchet).
 *
 * Takes the sweep's (customer, tenant) groups and returns the ones whose tenant `acceptsAutomatedWrites`. A group
 * with no tenantId is dropped here too (the caller counts and warns about those separately: B323), and a tenant
 * whose row cannot be read is treated as closed (fail closed - this job writes). One status read per sweep.
 */
export async function openTenantGroups<G extends { tenantId: string | null }>(
  prisma: Pick<PrismaService, "tenant">,
  groups: readonly G[],
): Promise<G[]> {
  const withTenant = groups.filter((g) => g.tenantId);
  const ids = [...new Set(withTenant.map((g) => g.tenantId as string))];
  if (ids.length === 0) return [];
  const rows = await prisma.tenant.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
  });
  const open = new Set(rows.filter((t) => acceptsAutomatedWrites(t.status)).map((t) => t.id));
  return withTenant.filter((g) => open.has(g.tenantId as string));
}
