/**
 * SA-488 (#2493 item 3): the current tenant's IANA zone (TenantConfig.timezone), or null when there
 * is no tenant context or no zone is set — callers then fall back to UTC through calendar-date.ts.
 * Resolved once per report, never per row.
 */
export async function tenantTimeZone(prisma: {
  getTenantId(): string | null | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PrismaService and its test mock both fit
  tenantConfig: { findUnique(args: any): Promise<{ timezone?: string | null } | null> };
}): Promise<string | null> {
  const tenantId = prisma.getTenantId();
  if (!tenantId) return null;
  const cfg = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  return cfg?.timezone ?? null;
}
