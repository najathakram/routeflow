/**
 * Groups the orders picked for an ad-hoc trip into one delivery stop per
 * distinct customer.
 *
 * This module is mirrored verbatim across the shared package and both clients
 * (`packages/types/trip-grouping.ts` — consumed by the web trip builder,
 * `apps/mobile/lib/trip-grouping.ts`, and this API copy) — change all of them
 * together so the client previews and the server's stop list can never
 * disagree. The API keeps a local copy rather than importing `@routeflow/types`
 * because that package's entry point is raw TypeScript (`main: "./index.ts"`,
 * no build step): `nest build` emits the `require("@routeflow/types")` verbatim
 * and `node dist/main.js` then dies parsing the .ts at startup. Same convention
 * as `apps/api/src/common/shipping.ts`. It is pure TS with no framework imports
 * so the copies stay identical.
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
 * (client preview), the API TripsService (server truth), and mirrored in
 * mobile at apps/mobile/lib/trip-grouping.ts, so all three agree.
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
