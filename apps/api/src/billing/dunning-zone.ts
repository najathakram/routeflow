import { tenantTimeZone } from "../common/tenant-time-zone";
import { DUNNING_FALLBACK_ZONE } from "./dunning-config";

/**
 * The tenant's IANA zone for the 03:00 pause rule - the ONE place the dunning sweep resolves it.
 *
 * SA-733r6 asks for the tenant-zone resolver (`resolveZone` / `FALLBACK_ZONE`, branch
 * `feat/tenant-zone-resolver-api`, SA-738). This branch is built on the B2 stack, which predates it, so this adapter
 * calls the resolver that IS here (`tenantTimeZone`, explicit tenant id) and falls back to UTC. When the resolver
 * branch lands, replace the body with `(await resolveZone(prisma, { tenantId })).zone` - no caller changes.
 */
export async function dunningZone(
  prisma: Parameters<typeof tenantTimeZone>[0],
  tenantId: string,
): Promise<string> {
  try {
    return (await tenantTimeZone(prisma, tenantId)) ?? DUNNING_FALLBACK_ZONE;
  } catch {
    return DUNNING_FALLBACK_ZONE; // a zone lookup must never stop a sweep
  }
}
