import { ConflictException } from "@nestjs/common";
import { FulfillPath, OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { SHIPPING_FULFILMENT_MODES } from "./shipping-fulfilment-modes";

const CLOSED_ORDER_STATUSES: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.CANCELLED];

type OrderCounter = { order: { count(args: any): Promise<number> } };

/**
 * M1 interim rule: a `fulfilment_model` change that moves the billing moment (into or out of the
 * shipping modes) while a carrier order is in flight would bill it twice or never. This is the ONE rule, in
 * its non-throwing form (BO-04): how many carrier orders are in flight, or 0 when the change keeps the
 * billing moment (no query is made then). Callers that must refuse use `assertNoCarrierInTransit`; callers
 * that report it (the capabilities preview's `blocked`) read the count.
 */
export async function carrierInTransitCount(
  db: OrderCounter,
  tenantId: string,
  from: string,
  to: string,
): Promise<number> {
  if (SHIPPING_FULFILMENT_MODES.has(from) === SHIPPING_FULFILMENT_MODES.has(to)) return 0;
  return db.order.count({
    where: {
      tenantId,
      fulfillPath: FulfillPath.SHIP,
      status: { notIn: CLOSED_ORDER_STATUSES },
      shippedAt: { not: null },
    },
  });
}

/** The 409 every refusal of this rule sends (one body: Settings, the console and the profile apply). */
export function carrierInTransitConflict(count: number): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT,
    message:
      "Orders are with the carrier right now. Change the delivery method once they are delivered.",
    count,
  });
}

/**
 * Every writer of the model shares this one check: tenant Settings → Fulfillment (inside its write, under the
 * lock), the Feature Console `set()` / `clear()` of `fulfilment_model` (inside the fulfilment lock), and the
 * platform-admin business-profile / capabilities apply (before any write).
 */
export async function assertNoCarrierInTransit(
  db: OrderCounter,
  tenantId: string,
  from: string,
  to: string,
): Promise<void> {
  const count = await carrierInTransitCount(db, tenantId, from, to);
  if (count > 0) throw carrierInTransitConflict(count);
}
