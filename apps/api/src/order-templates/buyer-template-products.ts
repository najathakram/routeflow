import { NotFoundException } from "@nestjs/common";
import {
  buyerVisibilityFor,
  isBuyerVisibleProduct,
  PORTAL_PARENT_INCLUDE,
} from "../buyer/buyer-product-visibility";
import { requireRestrictionTenantId } from "../selling-restrictions/restriction-tenant";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

/**
 * A BUYER saving a standing order may only list products the portal shows them. A hidden product (portal-hidden,
 * inactive, under a hidden parent, restricted for them), a hidden FAMILY and a missing id are ONE answer: the same
 * 404, no product name, no ids, checked before anything is stored. Staff paths do not call this.
 */
export async function assertBuyerMayListProducts(
  deps: {
    prisma: { forTenant(): any; getTenantId(): string | null | undefined };
    restrictions: Pick<SellingRestrictionsService, "restrictedProductIdsFor">;
  },
  customerId: string,
  productIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(productIds)];
  const rows: Array<Parameters<typeof isBuyerVisibleProduct>[1]> = await deps.prisma
    .forTenant()
    .product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        kind: true,
        isActive: true,
        portalVisible: true,
        ...PORTAL_PARENT_INCLUDE,
      },
    });
  const visibility = await buyerVisibilityFor(
    deps.restrictions,
    requireRestrictionTenantId(deps.prisma.getTenantId()),
    customerId,
  );
  if (rows.length !== ids.length || rows.some((p) => !isBuyerVisibleProduct(visibility, p)))
    throw new NotFoundException("Product not found");
}
