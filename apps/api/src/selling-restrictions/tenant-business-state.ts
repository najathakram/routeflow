import { normalizeUsState } from "../common/us-states";
import type { PrismaService } from "../prisma/prisma.service";

/** The legacy SystemConfig key Settings > Business falls back to when the tenant has no TenantConfig address. */
export const LEGACY_BUSINESS_STATE_KEY = "settings.state";

/**
 * The tenant's OWN business-address state as a USPS code, or null when none is usable: the ONE reader the
 * selling-restrictions engine uses for a counter sale to the system walk-in, which has no address of its own and so is
 * judged where the store is. Same source and precedence as Settings > Business (`SettingsController.getSettings`):
 * `TenantConfig.state` when it is set (even blank), else the legacy `settings.state` SystemConfig row. A value the
 * engine cannot read (`normalizeUsState` -> null) is "no state", never a guess.
 */
export async function tenantBusinessState(
  prisma: Pick<PrismaService, "tenantConfig" | "forTenant">,
  tenantId: string,
): Promise<string | null> {
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { state: true },
  });
  if (config?.state != null) return normalizeUsState(config.state);
  const legacy = await prisma.forTenant().systemConfig.findFirst({
    where: { tenantId, key: LEGACY_BUSINESS_STATE_KEY },
    select: { value: true },
  });
  return normalizeUsState(legacy?.value);
}
