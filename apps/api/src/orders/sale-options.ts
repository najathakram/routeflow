import { BadRequestException } from "@nestjs/common";
import type { FulfillPath } from "@prisma/client";
import type { CreateOrderOptions } from "./order-create-options";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { CreateSaleDto } from "./dto/create-sale.dto";
import { parseOrderDate } from "./order-parsers";

/**
 * INTERNAL options of `OrdersService.createSale` (SA-655): the counter sale threads these through the
 * prod-proven create -> DELIVERED -> invoice -> send flow. POST /orders/sell passes none and is unchanged.
 *  - `fulfillPath`: handed to create() as an internal option (PICKUP is not a writable DTO value).
 *  - `counterSale` (SA-672e): stamp Order.counterSale (only the counter POST sets it).
 *  - `suppressInvoiceNotify`: send the invoice without the INVOICE_SENT message (the walk-in has no mailbox).
 *  - `onReplay`: called when `dto.idempotencyKey` replayed an earlier sale; createSale then RESUMES it.
 */
export interface SaleOptions {
  fulfillPath?: FulfillPath;
  counterSale?: boolean;
  suppressInvoiceNotify?: boolean;
  onReplay?: (order: { id: string; status?: string; counterSale?: boolean }) => void;
}

/**
 * The delivery-date picker (owner 2026-08-25): `deliveredOn` REPLACES `deliveredNow`'s binary when
 * present — past/today is a (back)dated delivered sale, a future date is a scheduled deliver-later
 * order carrying that requested date. `deliveredNow` is still honoured alone for older clients; when
 * both are sent, `deliveredOn` wins. Extracted verbatim from createSale.
 */
export function resolveSaleDelivery(dto: CreateSaleDto, user: JwtPayload) {
  let deliveredNow = dto.deliveredNow;
  let deliveredAt = parseOrderDate(dto.orderDate, user.role);
  let requestedDeliveryDate = dto.requestedDeliveryDate;
  if (dto.deliveredOn != null) {
    const parsed = new Date(dto.deliveredOn);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException("Invalid delivery date");
    const now = new Date();
    const endOfToday = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      59,
      999,
    );
    if (parsed.getTime() > endOfToday) {
      deliveredNow = false;
      requestedDeliveryDate = dto.deliveredOn;
    } else {
      // Past/today: the sale happened on that day, so it goes through the same
      // staff-only gate and 2-year floor backdating has always had.
      deliveredNow = true;
      deliveredAt = parseOrderDate(dto.deliveredOn, user.role);
    }
  }
  return { deliveredNow, deliveredAt, requestedDeliveryDate };
}

/** The invoices of a replayed sale oldest first (createInvoiceFromOrder lists an already-invoiced order newest first). */
export function oldestFirst<T extends { createdAt?: Date | string }>(invoices: T[]): T[] {
  return [...invoices].sort((a, b) => +new Date(a.createdAt ?? 0) - +new Date(b.createdAt ?? 0));
}

/**
 * create()'s options for a sale: always `skipAutoMerge`; plus the internal PICKUP path and, ONLY when an
 * Idempotency-Key is present, the replay signal (so a plain /sell call is byte-identical to before).
 */
export function saleCreateOptions(
  sale: SaleOptions,
  idempotencyKey: string | undefined,
  markReplay: () => void,
): CreateOrderOptions {
  return {
    skipAutoMerge: true,
    ...(sale.fulfillPath ? { fulfillPath: sale.fulfillPath } : {}),
    ...(sale.counterSale ? { counterSale: true } : {}),
    ...(idempotencyKey
      ? {
          onReplay: (order) => {
            markReplay();
            sale.onReplay?.(order);
          },
        }
      : {}),
  };
}
