import { NotFoundException } from "@nestjs/common";
import type { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";

/**
 * The catalog's regulated-category gate, applied to a buyer's standing orders (`BuyerCatalogService.getProductDetail`
 * answers 404 for the same product). A category that requires a licence is hidden from a buyer with no verified,
 * unexpired authorization for it; every product in it is hidden with it. ONE source: `RegulatedVisibilityService`.
 */
export type BuyerRegulatedGate = Pick<RegulatedVisibilityService, "computeGate">;

/** The tracked-category ids this buyer may not see. Empty (and one cheap query) when no licence programme runs. */
export async function hiddenRegulatedCategoryIds(
  regulated: BuyerRegulatedGate,
  customerId: string,
): Promise<ReadonlySet<string>> {
  return (await regulated.computeGate(customerId)).hiddenIds;
}

/**
 * A BUYER saving a standing order may not list a product in a locked regulated category: the same 404 and body as a
 * hidden or missing product (`assertBuyerMayListProducts`), no name, no ids, checked before anything is stored. Staff
 * paths do not call this.
 */
export async function assertBuyerMayListRegulated(
  deps: {
    prisma: { forTenant(): any };
    regulated: BuyerRegulatedGate;
  },
  customerId: string,
  productIds: readonly string[],
): Promise<void> {
  const hidden = await hiddenRegulatedCategoryIds(deps.regulated, customerId);
  if (hidden.size === 0) return;
  const rows: Array<{ trackedCategoryId: string | null }> = await deps.prisma
    .forTenant()
    .product.findMany({
      where: { id: { in: [...new Set(productIds)] } },
      select: { trackedCategoryId: true },
    });
  if (rows.some((p) => p.trackedCategoryId !== null && hidden.has(p.trackedCategoryId)))
    throw new NotFoundException("Product not found");
}
