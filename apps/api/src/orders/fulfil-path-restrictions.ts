import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";
import type { HeldLine } from "../selling-restrictions/restriction-warning";
import type { SellableLinesArgs } from "../selling-restrictions/selling-restrictions.service";
import * as rGate from "./order-restriction-gate";

/**
 * Row 510: the fulfil-path switch (`PATCH /orders/:id/fulfill-path`) was the one staff write that changed WHICH STATE
 * judges an order and was not judged at all. Switching to PICKUP moves the sale to the store's state; switching to ROUTE
 * or SHIP moves it to the customer's address (`jurisdiction.ts`). So the switch re-judges every live catalog line of the
 * order at the path it is switching TO, warns / refuses like any staff sale, and writes the acknowledged stamps in the
 * SAME transaction as the path change (under `Order FOR UPDATE`, the product set re-checked, the hash re-judged).
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
  /** Anything for the lock-time re-judge to find? When false the switch needs no transaction of its own. */
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
    rGate.whole({ tenant, order, user, lines, dto: ack, fulfillPath: toPath }),
  );
  const judged = new Set<string>(lines.flatMap((l) => (l.productId ? [l.productId] : [])));
  return { decision, judged, needsTx: !!decision?.active };
}
