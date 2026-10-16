/**
 * The most ACTIVE units (`archivedAt` null) a tenant may have (SA-810). The units picker and the
 * Settings > Units list stay one screen and one query; real tenants use fewer than 30, and the cap is
 * there to stop import noise ("12ct", "24pk") from filling the list. Archive is the only delete, so
 * archiving frees a slot, and restoring an archived unit counts as an add.
 */
export const MAX_ACTIVE_TENANT_UNITS = 200;

interface TenantUnitCounter {
  tenantUnit: { count(args: { where: { tenantId: string; archivedAt: null } }): Promise<number> };
}

/**
 * How many more units the tenant may add: `MAX_ACTIVE_TENANT_UNITS` minus its active units. Zero or
 * less means full. A tenant already above the cap (U-6 backfill) keeps its rows and gets a negative
 * room: only adds are refused (a person, 409 TENANT_UNIT_LIMIT) or skipped (a level write, which
 * saves unlinked and reports `unitNotListed`).
 *
 * The ONE count both writers use. It is a soft cap: it is read under whatever tenant-units lock the
 * writer already holds (SHARED for a level write), so concurrent adds can overshoot by the number of
 * concurrent writers, never without bound. No exclusive lock is taken: that would serialize every
 * level write of the tenant.
 */
export async function unitRoom(db: TenantUnitCounter, tenantId: string): Promise<number> {
  const active = await db.tenantUnit.count({ where: { tenantId, archivedAt: null } });
  return MAX_ACTIVE_TENANT_UNITS - active;
}
