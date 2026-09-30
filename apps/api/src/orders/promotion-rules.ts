import { UserRole } from "@prisma/client";
import type { PromotionRule } from "@routeflow/pricing";
import type { PromotionsService } from "../promotions/promotions.service";

/**
 * Extracted verbatim from `OrdersService.loadActivePromotions` (size ratchet, #2717 M3): active
 * promotions for the current tenant (window + isActive filtered), only for the buyer (CUSTOMER)
 * self-service path; empty for staff so operator/driver order pricing is byte-for-byte unchanged.
 */
export async function loadActivePromotionRules(
  promotionsService: Pick<PromotionsService, "activeForCatalog">,
  role: UserRole,
): Promise<PromotionRule[]> {
  if (role !== UserRole.CUSTOMER) return [];
  const promos = await promotionsService.activeForCatalog();
  return promos.map((p) => ({
    id: p.id,
    type: p.type as PromotionRule["type"],
    value: Number(p.value),
    minQty: p.minQty,
    scope: p.scope as PromotionRule["scope"],
    category: p.category,
    productIds: p.productIds,
  }));
}
