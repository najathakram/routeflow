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
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";
import type { HeldLine } from "../selling-restrictions/restriction-warning";
import type { SellableLinesArgs } from "../selling-restrictions/selling-restrictions.service";
import * as rGate from "./order-restriction-gate";

/**
 * L8 addendum: a fulfil-path switch decides WHICH state judges the order's lines (pickup / counter: the store's;
 * route / ship: the customer's address), so it re-judges the order's CURRENT catalog lines, like a promotion does,
 * at the acting principal's channel, BEFORE the write, so a 409 SELLING_RESTRICTED leaves the path unchanged.
 *
 * Row 510: the staff switch (`updateFulfillPathImpl`) runs `assertFulfilPathAddress` and then `judgeFulfilSwitch`
 * below (the warning / override protocol, stamped in the path write's own transaction). This function is the same
 * guard and the same kind (the path switched TO; a counter sale stays COUNTER) through the plain choke point with no principal (a breach is a hard
 * 409): the engine-level contract `store-state-by-fulfilment.l8.db.spec.ts` pins against the real engine.
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
  assertFulfilPathAddress(order, target);
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

/**
 * PICKUP -> ROUTE / SHIP needs somewhere to deliver: a customer with no address is a coded 400, and nothing is judged
 * (there is no state to judge on). A DRAFT or a switch to the same path never reaches here.
 */
export function assertFulfilPathAddress(
  order: Pick<FulfilPathSwitchOrder, "fulfillPath" | "customer">,
  target: string,
): void {
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
}

/**
 * Row 510: the fulfil-path switch (`PATCH /orders/:id/fulfill-path`) was the one staff write that changed WHICH STATE
 * judges an order and was not judged at all. Switching to PICKUP moves the sale to the store's state; switching to ROUTE
 * or SHIP moves it to the customer's address (`sale-fulfilment.ts`). So the switch re-judges every live catalog line of the
 * order at the path it is switching TO, warns / refuses like any staff sale, and writes the acknowledged stamps in the
 * SAME transaction as the path change (under `Order FOR UPDATE`, the product set re-checked, the hash re-judged). The
 * lock and the product-set re-check run EVERY time a line was judged, clean read or not.
 *
 * The choke-point CALL stays in `OrdersService.updateFulfillPath` (the coverage ratchet scans class methods): it passes
 * `assertSellable` down, and this module builds the parameters around it. A DRAFT is judged at its promotion; a switch
 * to the path the order already has changes nothing.
 */

/** The answer of the choke point (undefined from a stub that resolves nothing). */
type AssertSellable = (params: SellableLinesArgs) => Promise<rGate.Decision | undefined>;

export interface FulfilSwitch {
  decision?: rGate.Decision;
  judged: ReadonlySet<string>;
  /**
   * Always true once any line was judged: the Order lock, the lock-time product-set check and the write are ONE
   * transaction even when the read before the lock was clean (a banned line added between that read and the write is a
   * product the judgement never saw), the same as reopen. Only a switch that judges nothing (null) skips it.
   */
  needsTx: boolean;
}

export async function judgeFulfilSwitch(
  self: { prisma: Pick<PrismaService, "forTenant" | "getTenantId"> },
  order: {
    id: string;
    status: string;
    tenantId: string | null;
    customerId: string;
    fulfillPath: string;
    counterSale?: boolean | null;
  },
  toPath: string,
  user: JwtPayload | undefined,
  assertSellable: AssertSellable,
  ack: rGate.Ack,
): Promise<FulfilSwitch | null> {
  if (order.status === "DRAFT" || toPath === order.fulfillPath) return null;
  const lines: HeldLine[] = await self.prisma.forTenant().orderItem.findMany({
    where: { orderId: order.id, status: { not: "CANCELLED" } },
    select: rGate.WHOLE_LINE_SELECT,
  });
  if (!lines.some((l) => l.productId)) return null;
  const tenant = rGate.tenantId(self.prisma, user, order.tenantId);
  const decision = await assertSellable(
    // judged at the path switched TO (a counter sale stays COUNTER whatever its path column says)
    rGate.whole({ tenant, order: { ...order, fulfillPath: toPath }, user, lines, dto: ack }),
  );
  const judged = new Set<string>(lines.flatMap((l) => (l.productId ? [l.productId] : [])));
  return { decision, judged, needsTx: true };
}
