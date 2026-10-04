import type { BuyerSellerCapability } from "@routeflow/types";

/**
 * Business profiles 1B — what a buyer sees about how an order travels, decided from the SELLER's
 * fulfilment capability (`GET /buyer/capabilities`) and nothing else.
 *
 * An UNSET seller (`portalDefault` null) is today's screen exactly — every order gets the route
 * timeline and the "Track your delivery" card, SHIP orders included — and so is a capability that
 * could not be read. Only a configured seller changes anything:
 * - a SHIP order is a shipment (carrier + tracking number, Confirmed → Shipped → Delivered);
 * - any other order shows route / driver / ETA wording only when the seller has a fleet.
 */

/**
 * `route` = today's timeline + tracking card; `shipment` = the SHIP timeline + shipment card;
 * `none` = a timeline with no route steps and no tracking card; `loading` = decide nothing yet.
 */
export type BuyerOrderTravelView = "loading" | "route" | "shipment" | "none";

export const SHIP_STEP_LABELS = ["Confirmed", "Shipped", "Delivered"] as const;
export const NO_FLEET_STEP_LABELS = ["Pending", "Confirmed", "Delivered"] as const;

export function isConfiguredSeller(
  cap: BuyerSellerCapability | null | undefined,
): cap is BuyerSellerCapability {
  return !!cap && cap.portalDefault !== null;
}

/** Route / driver / ETA wording: today's for unset or unread; a configured seller needs a fleet. */
export function sellerShowsRouteWording(cap: BuyerSellerCapability | null | undefined): boolean {
  return !isConfiguredSeller(cap) || cap.fleet;
}

export function orderTravelView(
  fulfillPath: string | null | undefined,
  cap: BuyerSellerCapability | null | undefined,
  capLoading: boolean,
): BuyerOrderTravelView {
  if (capLoading) return "loading";
  if (!isConfiguredSeller(cap)) return "route";
  if (fulfillPath === "SHIP") return "shipment";
  return cap.fleet ? "route" : "none";
}

interface ShipFields {
  status: string;
  shippedAt?: string | null;
  shippingTrackingNumber?: string | null;
}

const DISPATCHED = ["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED"];

/** Index into SHIP_STEP_LABELS (-1 = before Confirmed, or cancelled). */
export function shipStepIndex(o: ShipFields): number {
  if (o.status === "DELIVERED") return 2;
  if (o.status === "CANCELLED") return -1;
  if (o.shippedAt || DISPATCHED.includes(o.status)) return 1;
  return o.status === "CONFIRMED" ? 0 : -1;
}

/** Index into NO_FLEET_STEP_LABELS (-1 = draft, or cancelled). */
export function noFleetStepIndex(status: string): number {
  if (status === "PENDING") return 0;
  if (status === "CONFIRMED" || DISPATCHED.includes(status)) return 1;
  return status === "DELIVERED" ? 2 : -1;
}

export type ShipmentState = "not_shipped" | "shipped" | "delivered" | "cancelled";

export function shipmentState(o: ShipFields): ShipmentState {
  if (o.status === "CANCELLED") return "cancelled";
  if (o.status === "DELIVERED") return "delivered";
  if (o.shippedAt || o.shippingTrackingNumber || DISPATCHED.includes(o.status)) return "shipped";
  return "not_shipped";
}

/** The order's status label when it differs from today's formatted status; null = today's. */
export function buyerStatusLabel(o: ShipFields, view: BuyerOrderTravelView): string | null {
  if (view === "shipment") {
    const shipped = o.status === "OUT_FOR_DELIVERY" || (o.status === "CONFIRMED" && !!o.shippedAt);
    return shipped ? "Shipped" : null;
  }
  if (view === "none") return o.status === "OUT_FOR_DELIVERY" ? "On Its Way" : null;
  return null;
}

/**
 * An order list's status label override (orders list, dashboard): a configured seller without a
 * fleet never labels an order "Out For Delivery". null = today's formatted status.
 */
export function buyerListStatusLabel(
  status: string,
  cap: BuyerSellerCapability | null | undefined,
): string | null {
  return sellerShowsRouteWording(cap) ? null : buyerStatusLabel({ status }, "none");
}
