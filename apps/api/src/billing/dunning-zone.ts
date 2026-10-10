import { FALLBACK_ZONE, resolveZone } from "../common/tenant-time-zone";

/**
 * The tenant's IANA zone for the 03:00 pause rule - the ONE place the dunning sweep resolves it, through the
 * single tenant-zone reader (SA-738 `resolveZone`, context-object form with the explicit tenant id: the sweep is a
 * cron with no ambient tenant). A missing or invalid zone resolves to the reader's own UTC fallback, and a failed
 * lookup never stops a sweep.
 */
export async function dunningZone(
  prisma: Parameters<typeof resolveZone>[0],
  tenantId: string,
): Promise<string> {
  try {
    return (await resolveZone(prisma, { tenantId })).zone;
  } catch {
    return FALLBACK_ZONE; // a zone lookup must never stop a sweep
  }
}
