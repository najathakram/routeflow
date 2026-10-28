import { BadRequestException } from "@nestjs/common";
import type { FulfillPath } from "@prisma/client";
import type { CreateOrderOptions, ReplayedOrder } from "./order-create-options";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { CreateSaleDto } from "./dto/create-sale.dto";
import { parseOrderDate } from "./order-parsers";
import { calendarDateFromIso, startOfCalendarDay } from "../common/calendar-date";

/**
 * INTERNAL options of `OrdersService.createSale` (SA-655): the counter sale threads these through the
 * prod-proven create -> DELIVERED -> invoice -> send flow. POST /orders/sell passes none and is unchanged.
 *  - `fulfillPath`: handed to create() as an internal option (PICKUP is not a writable DTO value).
 *  - `counterSale` (SA-672e): stamp Order.counterSale (only the counter POST sets it).
 *  - `suppressInvoiceNotify`: send the invoice without the INVOICE_SENT message (the walk-in has no mailbox).
 *  - `creditPaidNow` (S1): create()'s option of the same name (counter sale only; absent for /sell).
 *  - `onReplay`: called when `dto.idempotencyKey` replayed an earlier sale; createSale then RESUMES it.
 */
export interface SaleOptions {
  fulfillPath?: FulfillPath;
  counterSale?: boolean;
  suppressInvoiceNotify?: boolean;
  onReplay?: (order: ReplayedOrder) => void;
  /** B1209: create()'s `beforeWrite` (the server total, before anything is written). */
  beforeWrite?: (priced: { total: number }) => void | Promise<void>;
  /** S1: create()'s `creditPaidNow` (the credit gate counts only what stays owed after this tender). */
  creditPaidNow?: (total: number) => number;
}

/**
 * The delivery-date picker (owner 2026-08-25): `deliveredOn` REPLACES `deliveredNow`'s binary when
 * present — past/today is a (back)dated delivered sale, a future date is a scheduled deliver-later
 * order carrying that requested date. `deliveredNow` is still honoured alone for older clients; when
 * both are sent, `deliveredOn` wins. Extracted verbatim from createSale.
 *
 * Row 735b: "today" is the TENANT's calendar day in `zone` (`TenantConfig.timezone`, UTC when null/invalid - the
 * `calendar-date.ts` contract and the same helpers as the past-date guard), not the UTC day. The day the picker
 * sent is read by its literal first ten characters (the house rule) and compared as a day: later than the tenant's
 * today is a scheduled order, today and earlier a delivered sale. `now` is the clock (tests).
 */
export function resolveSaleDelivery(
  dto: CreateSaleDto,
  user: JwtPayload,
  zone?: string | null,
  now: Date = new Date(),
) {
  let deliveredNow = dto.deliveredNow;
  let deliveredAt = parseOrderDate(dto.orderDate, user.role);
  let requestedDeliveryDate = dto.requestedDeliveryDate;
  if (dto.deliveredOn != null) {
    const parsed = new Date(dto.deliveredOn);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException("Invalid delivery date");
    if (dto.deliveredOn.slice(0, 10) > calendarDateFromIso(startOfCalendarDay(now, zone))) {
      deliveredNow = false;
      requestedDeliveryDate = dto.deliveredOn;
    } else {
      // Past/today: the sale happened on that day, so it goes through the same
      // staff-only gate and 2-year floor backdating has always had.
      deliveredNow = true;
      deliveredAt = parseOrderDate(dto.deliveredOn, user.role, { zone, now });
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
    ...(sale.beforeWrite ? { beforeWrite: sale.beforeWrite } : {}),
    ...(sale.creditPaidNow ? { creditPaidNow: sale.creditPaidNow } : {}),
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
