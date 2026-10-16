import {
  buyerVisibilityFor,
  isBuyerVisibleProduct,
  PORTAL_PARENT_SELECT,
} from "../buyer/buyer-product-visibility";
import type { BuyerVisibilityContext } from "../buyer/buyer-product-visibility";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { hiddenRegulatedCategoryIds } from "./buyer-template-regulated";
import type { BuyerRegulatedGate } from "./buyer-template-regulated";

/**
 * Row 479: what a BUYER-side template read loads per line. The staff shape (`id`, `name`, `unit`) plus exactly the
 * facts the catalog rules need (`isBuyerVisibleProduct`, and the regulated-category gate); they are stripped again
 * before the response, so a buyer's product object keeps the staff read's shape and never gains a field.
 */
export const BUYER_TEMPLATE_PRODUCT_SELECT = {
  id: true,
  name: true,
  unit: true,
  isActive: true,
  kind: true,
  portalVisible: true,
  trackedCategoryId: true,
  parent: { select: PORTAL_PARENT_SELECT },
} as const;

/** Everything a buyer read judges a line against: the portal rule's context and the locked regulated categories. */
export interface BuyerTemplateReadContext {
  visibility: BuyerVisibilityContext;
  hiddenCategoryIds: ReadonlySet<string>;
}

export async function buyerTemplateReadContext(
  deps: {
    restrictions: Pick<SellingRestrictionsService, "restrictedProductIdsFor">;
    regulated: BuyerRegulatedGate;
  },
  tenantId: string | null | undefined,
  customerId: string,
): Promise<BuyerTemplateReadContext> {
  return {
    visibility: await buyerVisibilityFor(deps.restrictions, tenantId, customerId),
    hiddenCategoryIds: await hiddenRegulatedCategoryIds(deps.regulated, customerId),
  };
}

/** Drop the lines the catalog would hide from this buyer and trim every kept product back to `{ id, name, unit }`. */
export function toBuyerView<
  T extends {
    items: Array<{
      product: {
        id: string;
        name: string;
        unit: string;
        isActive: boolean;
        kind: string;
        portalVisible: boolean;
        trackedCategoryId: string | null;
        parent: { portalVisible: boolean; isActive: boolean; tenantId: string | null } | null;
      };
    }>;
  },
>(template: T, ctx: BuyerTemplateReadContext) {
  return {
    ...template,
    items: template.items
      .filter(
        (item) =>
          isBuyerVisibleProduct(ctx.visibility, item.product) &&
          !(
            item.product.trackedCategoryId !== null &&
            ctx.hiddenCategoryIds.has(item.product.trackedCategoryId)
          ),
      )
      .map((item) => ({
        ...item,
        product: { id: item.product.id, name: item.product.name, unit: item.product.unit },
      })),
  };
}
