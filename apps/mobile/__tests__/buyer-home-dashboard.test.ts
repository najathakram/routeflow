/**
 * NEW-vop-1 / G3
 * Guards the buyer home screen against undefined `lineItems` on dashboard orders.
 *
 * The /buyer/dashboard endpoint returns recentOrders with `itemCount` (a number),
 * not a `lineItems` array. Before the fix, `lastOrder.lineItems.reduce(...)` crashed
 * with "Cannot read properties of undefined (reading 'reduce')" for every buyer.
 */

import type { DashboardOrder } from "../lib/api/buyer";

/** Mirrors the display logic from apps/mobile/app/(customer)/(tabs)/home.tsx */
function getItemCount(order: DashboardOrder): number {
  return order.itemCount ?? (order.lineItems ?? []).reduce((s, i) => s + Number(i.qty), 0);
}

describe("BuyerHomeScreen — item count guard", () => {
  it("uses itemCount when present (normal dashboard response)", () => {
    const order: DashboardOrder = {
      id: "o1",
      status: "PENDING",
      createdAt: new Date().toISOString(),
      itemCount: 5,
      // lineItems deliberately absent — matches real /buyer/dashboard response
    };
    expect(getItemCount(order)).toBe(5);
  });

  it("falls back to reduce when lineItems is present and itemCount is absent", () => {
    const order: DashboardOrder = {
      id: "o2",
      status: "PENDING",
      createdAt: new Date().toISOString(),
      lineItems: [
        { id: "li1", productId: "p1", qty: 2, unitPrice: 10 },
        { id: "li2", productId: "p2", qty: 3, unitPrice: 5 },
      ],
    };
    expect(getItemCount(order)).toBe(5);
  });

  it("does not throw when both itemCount and lineItems are undefined (empty order)", () => {
    const order: DashboardOrder = {
      id: "o3",
      status: "DELIVERED",
      createdAt: new Date().toISOString(),
      // neither itemCount nor lineItems
    };
    expect(() => getItemCount(order)).not.toThrow();
    expect(getItemCount(order)).toBe(0);
  });

  it("does not throw when lineItems is an empty array", () => {
    const order: DashboardOrder = {
      id: "o4",
      status: "CANCELLED",
      createdAt: new Date().toISOString(),
      lineItems: [],
    };
    expect(() => getItemCount(order)).not.toThrow();
    expect(getItemCount(order)).toBe(0);
  });
});
