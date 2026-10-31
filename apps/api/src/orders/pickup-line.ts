import type { PrismaService } from "../prisma/prisma.service";

export interface PickupAddress {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

const clean = (s: string | null | undefined): string => (s ?? "").trim();

/**
 * The ` Pick up at <address>.` tail of the Ready for pickup email (W-1043, SA-1062 MUST 20), or "" when the
 * business has no street address. The ONE seam for it: #3167's opening hours join this sentence here, nowhere else.
 */
export function pickupLineOf(address: PickupAddress | null | undefined): string {
  const street = clean(address?.street);
  if (!street) return "";
  const cityLine = [
    [clean(address?.city), clean(address?.state)].filter(Boolean).join(", "),
    clean(address?.zip),
  ]
    .filter(Boolean)
    .join(" ");
  return ` Pick up at ${[street, cityLine].filter(Boolean).join(", ")}.`;
}

const SETTING_KEYS = ["settings.street", "settings.city", "settings.state", "settings.zip"];

/**
 * The business address, with the receipt's fallback (documents/receipt.service.ts): the tenant config's own
 * field first, else the matching `settings.*` row. Tenant-scoped; never throws (a failed read is "no address").
 */
export async function readPickupAddress(
  prisma: Pick<PrismaService, "tenantConfig" | "forTenant">,
  tenantId: string | null | undefined,
): Promise<PickupAddress> {
  if (!tenantId) return {};
  try {
    const [config, rows] = await Promise.all([
      prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: { addressLine1: true, city: true, state: true, zip: true },
      }),
      prisma.forTenant().systemConfig.findMany({
        where: { key: { in: SETTING_KEYS } },
        select: { key: true, value: true },
      }),
    ]);
    const s = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
    return {
      street: config?.addressLine1 ?? s["settings.street"],
      city: config?.city ?? s["settings.city"],
      state: config?.state ?? s["settings.state"],
      zip: config?.zip ?? s["settings.zip"],
    };
  } catch {
    return {};
  }
}
