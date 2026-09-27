/**
 * SA-488 (#2493 item 3): the current tenant's IANA zone (TenantConfig.timezone), or null when there
 * is no tenant context or no zone is set — callers then fall back to UTC through calendar-date.ts.
 * Resolved once per report, never per row.
 */
export async function tenantTimeZone(
  prisma: {
    getTenantId(): string | null | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PrismaService and its test mock both fit
    tenantConfig: { findUnique(args: any): Promise<{ timezone?: string | null } | null> };
  },
  // #2556 B3: a caller that KNOWS its tenant (a fire-and-forget path with no ambient tenant
  // context) passes it; the ambient tenant is only the fallback.
  explicitTenantId?: string | null,
): Promise<string | null> {
  const tenantId = explicitTenantId || prisma.getTenantId();
  if (!tenantId) return null;
  const cfg = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  return cfg?.timezone ?? null;
}
