import { capabilityForMode } from "../billing/fulfilment-capability";
import type { PrismaService } from "../prisma/prisma.service";

/** The `TenantFeatureConfig.featureKey` Settings > Fulfillment writes (same literal as `FULFILMENT_MODEL_KEY`). */
const FULFILMENT_MODEL_FEATURE_KEY = "fulfilment_model";

/**
 * L8 M1: true when the tenant's STORED `fulfilment_model` offers PICKUP and nothing else (`pickup`), read through the
 * ONE capability derivation (`capabilityForMode`, never a second mode table). Such a tenant's buyers collect in store,
 * so the buyer portal judges them by the STORE's state. Every other model (`pickup_ship`, `ship`, `delivery`, `both`,
 * `unset`, an unknown value, no row) is "ships" and keeps the buyer's governing state.
 */
export async function tenantIsPickupOnly(
  prisma: Pick<PrismaService, "tenantFeatureConfig">,
  tenantId: string,
): Promise<boolean> {
  const methods = capabilityForMode(await storedFulfilmentMode(prisma, tenantId)).methods;
  return methods.length === 1 && methods[0] === "PICKUP";
}

/** The tenant's stored `fulfilment_model` mode ("unset" when no row). */
export async function storedFulfilmentMode(
  prisma: Pick<PrismaService, "tenantFeatureConfig">,
  tenantId: string,
): Promise<string> {
  const row = await prisma.tenantFeatureConfig.findFirst({
    where: { tenantId, featureKey: FULFILMENT_MODEL_FEATURE_KEY },
    select: { mode: true },
  });
  return row?.mode ?? "unset";
}
