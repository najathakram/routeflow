import { BadRequestException } from "@nestjs/common";
import { FulfillPath, OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { saleFulfilmentKind } from "../selling-restrictions/sale-fulfilment";
import {
  restrictionChannelForPrincipal,
  type ChannelPrincipal,
} from "../selling-restrictions/selling-restrictions.core";
import { requireRestrictionTenantId } from "../selling-restrictions/restriction-tenant";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

/**
 * L8 addendum: a fulfil-path switch decides WHICH state judges the order's lines (pickup / counter: the store's;
 * route / ship: the customer's address), so it re-judges the order's CURRENT catalog lines, like a promotion does,
 * at the acting principal's channel. Runs BEFORE the write, outside any transaction (`updateFulfillPathImpl` has
 * none: the write is one conditional statement), so a 409 SELLING_RESTRICTED leaves the path unchanged.
 *
 *  - a DRAFT is judged at its promotion (with whatever path it then has), never on a switch;
 *  - the SAME path again is no change: nothing is judged;
 *  - PICKUP -> ROUTE / SHIP needs somewhere to deliver: a customer with no address is a coded 400 and nothing is
 *    judged (there is no state to judge on);
 *  - a counter sale (`counterSale`) is a counter sale whatever its path column says, so it stays COUNTER.
 */
export interface FulfilPathSwitchOrder {
  tenantId?: string | null;
  customerId?: string | null;
  status?: string | null;
  fulfillPath?: string | null;
  counterSale?: boolean | null;
  customer?: { addresses?: ReadonlyArray<unknown> } | null;
  lineItems?: ReadonlyArray<{ productId?: string | null }> | null;
}

export async function assertFulfilPathSwitchAllowed(
  restrictions: Pick<SellingRestrictionsService, "assertLinesSellable">,
  p: {
    order: FulfilPathSwitchOrder;
    target: FulfillPath;
    principal: (ChannelPrincipal & { tenantId?: string | null }) | undefined;
    ambientTenantId: string | null;
  },
): Promise<void> {
  const { order, target } = p;
  if (order.status === OrderStatus.DRAFT || order.fulfillPath === target) return;
  const toDelivery = target === FulfillPath.ROUTE || target === FulfillPath.SHIP;
  if (
    toDelivery &&
    order.fulfillPath === FulfillPath.PICKUP &&
    order.customer &&
    (order.customer.addresses ?? []).length === 0
  ) {
    throw new BadRequestException({
      code: API_ERROR_CODES.ORDER_DELIVERY_ADDRESS_MISSING,
      message: "This customer has no delivery address on file.",
    });
  }
  const lines = (order.lineItems ?? []).flatMap((li) =>
    li.productId ? [{ productId: li.productId }] : [],
  );
  if (lines.length === 0) return;
  await restrictions.assertLinesSellable({
    tenantId: requireRestrictionTenantId(
      order.tenantId ?? p.principal?.tenantId ?? p.ambientTenantId,
    ),
    customerId: order.customerId ?? null,
    lines,
    channel: restrictionChannelForPrincipal(p.principal),
    fulfilmentKind: saleFulfilmentKind({ counterSale: order.counterSale, fulfillPath: target }),
  });
}
