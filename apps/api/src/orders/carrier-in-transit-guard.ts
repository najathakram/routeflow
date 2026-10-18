import { ConflictException } from "@nestjs/common";
import { FulfillPath, OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { SHIPPING_FULFILMENT_MODES } from "./shipping-fulfilment-modes";

const CLOSED_ORDER_STATUSES: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.CANCELLED];

/**
 * M1 interim rule: a `fulfilment_model` change that moves the billing moment (into or out of the
 * shipping modes) while a carrier order is in flight would bill it twice or never. Every writer of
 * the model shares this one check: tenant Settings → Fulfillment (inside its write, under the lock)
 * and the platform-admin business-profile plan (preview and confirm, before any write).
 */
export async function assertNoCarrierInTransit(
  db: { order: { count(args: any): Promise<number> } },
  tenantId: string,
  from: string,
  to: string,
): Promise<void> {
  if (SHIPPING_FULFILMENT_MODES.has(from) === SHIPPING_FULFILMENT_MODES.has(to)) return;
  const count = await db.order.count({
    where: {
      tenantId,
      fulfillPath: FulfillPath.SHIP,
      status: { notIn: CLOSED_ORDER_STATUSES },
      shippedAt: { not: null },
    },
  });
  if (count > 0) {
    throw new ConflictException({
      statusCode: 409,
      code: API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT,
      message:
        "Orders are with the carrier right now. Change the delivery method once they are delivered.",
      count,
    });
  }
}
