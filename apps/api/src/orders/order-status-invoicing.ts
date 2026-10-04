/**
 * Order invoicing on a manual status change — the invoice-settling block of `changeStatus`, lifted
 * out of `OrdersService` (it sits at its size-ratchet cap) so one body serves BOTH moments:
 *
 *  - "delivered": every order, as before (byte-identical behaviour, message text and log text).
 *  - "shipped": a carrier-shipped order (fulfillPath SHIP) whose tenant is set to shipping
 *    (`fulfilment_model` effective mode in SHIPPING_FULFILMENT_MODES) is invoiced when it goes to
 *    OUT_FOR_DELIVERY ("Shipped"), through the SAME logic. A later DELIVERED cannot invoice twice:
 *    an open mirror draft is reconciled (idempotent), and createInvoiceFromOrderWithTenant bills only
 *    each line's un-invoiced remainder, so with nothing left it returns the existing invoice(s).
 *
 * Tenants whose mode is unset (or whose key is not registered, which reads as "unset") are unchanged:
 * they invoice at DELIVERED only. The credit-limit gate ("goods leaving") already ran before the
 * status write for OUT_FOR_DELIVERY, so nothing here bypasses it. Whole order only: nothing is
 * invented for a partial shipment.
 */
import { ConflictException, Logger } from "@nestjs/common";
import { FulfillPath, OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { OrdersService } from "./orders.service";

export const FULFILMENT_MODEL_KEY = "fulfilment_model";
/** Effective `fulfilment_model` modes under which the business ships (and so bills at shipment). */
export const SHIPPING_FULFILMENT_MODES: ReadonlySet<string> = new Set([
  "ship",
  "both",
  "pickup_ship",
]);

/** True when this order is billed at SHIPMENT: a carrier (SHIP) order of a business whose effective
 *  `fulfilment_model` ships (ship / both / pickup_ship). The ONE billing-moment predicate: the
 *  status-change invoicing, the pending-mirror lock and the delivered-basis rebuild all key on it. */
export async function billsAtShipment(
  featureConfig: { getEffectiveMode(tenantId: string, key: string): Promise<string> } | undefined,
  tenantId: string | null | undefined,
  order: { fulfillPath: FulfillPath },
): Promise<boolean> {
  if (order.fulfillPath !== FulfillPath.SHIP) return false;
  if (!featureConfig || !tenantId) return false;
  try {
    return SHIPPING_FULFILMENT_MODES.has(
      await featureConfig.getEffectiveMode(tenantId, FULFILMENT_MODEL_KEY),
    );
  } catch {
    return false; // an unreadable mode is "unset": today's behaviour
  }
}

/** True when this status change must invoice at SHIPMENT (not wait for DELIVERED). */
export async function invoicesAtShipment(
  featureConfig: { getEffectiveMode(tenantId: string, key: string): Promise<string> } | undefined,
  tenantId: string | null | undefined,
  order: { fulfillPath: FulfillPath },
  toStatus: OrderStatus,
): Promise<boolean> {
  if (toStatus !== OrderStatus.OUT_FOR_DELIVERY) return false;
  return billsAtShipment(featureConfig, tenantId, order);
}

/**
 * Manual "mark delivered/shipped" = whole order. If the order has a pending mirror draft, reconcile
 * it to the order and leave it DRAFT for staff to review & send. Otherwise auto-create (explicit
 * tenantId), awaited, up to 3 attempts retrying ONLY a ConflictException (B105): the order-number
 * race regenerates internally on the next attempt. Returns the failure for the caller to raise AFTER
 * its notifications (the goods physically moved, the customer must still hear about it); the status
 * write is never reverted.
 */
export async function settleOrderInvoice(
  self: OrdersService,
  id: string,
  logger: Logger,
  moment: "delivered" | "shipped",
): Promise<ConflictException | undefined> {
  const draft = await self.invoicesService.findOpenOrderDraft(id);
  if (draft) {
    await self.invoicesService.reconcileOrderDraftInvoice(id, { basis: "order" });
    return undefined;
  }
  const capturedTenantId = self.prisma.getTenantId();
  const MAX_INVOICE_ATTEMPTS = 3;
  let lastErr: any;
  let attemptsMade = 0;
  for (let attempt = 0; attempt < MAX_INVOICE_ATTEMPTS; attempt++) {
    attemptsMade = attempt + 1;
    try {
      await self.invoicesService.createInvoiceFromOrderWithTenant(id, capturedTenantId);
      lastErr = undefined;
      break;
    } catch (err: any) {
      lastErr = err;
      if (!(err instanceof ConflictException)) break;
    }
  }
  if (!lastErr) return undefined;
  logger.error(
    `Failed to auto-create invoice for order ${id} after ${attemptsMade} attempt(s): ${lastErr?.message ?? lastErr}`,
  );
  return new ConflictException(
    `The order was marked ${moment}, but its invoice could not be created ` +
      `(${lastErr?.message ?? "unknown error"}). Use "Generate Invoice (full order)" on ` +
      `the order page to retry — the order stays ${moment} and nothing has been billed yet.`,
  );
}

/**
 * L6: a CARRIER (SHIP) order that is out with the carrier is not cancelled — cancelling credits its
 * units back to stock while the parcel is still in transit. It goes through the return flow instead.
 * A 409 before any write; every other order (and every other status) is unchanged.
 */
export function assertCarrierOrderNotInTransit(order: {
  status: OrderStatus;
  fulfillPath: FulfillPath;
}): void {
  if (order.status === OrderStatus.OUT_FOR_DELIVERY && order.fulfillPath === FulfillPath.SHIP) {
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_WITH_CARRIER_NO_CANCEL,
      message: "This order is already with the carrier. Use a return instead of cancelling.",
    });
  }
}
