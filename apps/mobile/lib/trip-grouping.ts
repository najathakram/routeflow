/**
 * Byte-for-byte mirror of `packages/types/trip-grouping.ts`. Mobile Jest's
 * `moduleNameMapper` stubs `@routeflow/types` (see `jest.config.js`), so this
 * module — like `lib/shipping.ts` — is duplicated locally rather than
 * imported, and must be changed in lockstep with the shared original so the
 * web trip builder, the API's `TripsService`, and this mobile copy all agree
 * on which orders become which stop.
 */

export interface TripGroupableOrder {
  id: string;
  orderNumber?: string | null;
  customerId?: string | null;
  customerName?: string | null;
}

export interface TripStopGroup {
  customerId: string;
  customerName: string | null;
  orderIds: string[];
}

export interface TripSkippedOrder {
  orderId: string;
  orderNumber: string | null;
  reason: "NO_CUSTOMER";
}

export interface TripGroupingResult {
  groups: TripStopGroup[];
  skipped: TripSkippedOrder[];
}

/**
 * Groups orders into one delivery stop per distinct customer, preserving
 * first-seen order. Pure and deterministic — consumed by the web trip builder
 * (client preview) and mirrored verbatim in the API
 * (apps/api/src/common/trip-grouping.ts — server truth) and mobile
 * (apps/mobile/lib/trip-grouping.ts), so all three agree. Change all three
 * together.
 */
export function groupOrdersForTrip(orders: TripGroupableOrder[]): TripGroupingResult {
  const groups: TripStopGroup[] = [];
  const byCustomer = new Map<string, TripStopGroup>();
  const skipped: TripSkippedOrder[] = [];
  for (const order of orders) {
    if (!order.customerId) {
      skipped.push({
        orderId: order.id,
        orderNumber: order.orderNumber ?? null,
        reason: "NO_CUSTOMER",
      });
      continue;
    }
    let group = byCustomer.get(order.customerId);
    if (!group) {
      group = {
        customerId: order.customerId,
        customerName: order.customerName ?? null,
        orderIds: [],
      };
      byCustomer.set(order.customerId, group);
      groups.push(group);
    }
    if (!group.orderIds.includes(order.id)) group.orderIds.push(order.id);
  }
  return { groups, skipped };
}
