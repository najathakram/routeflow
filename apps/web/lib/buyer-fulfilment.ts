import {
  API_ERROR_CODES,
  type BuyerSellerCapability,
  type FulfilmentMethod,
} from "@routeflow/types";

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

export type ShipmentState = "not_shipped" | "shipped" | "delivered" | "cancelled";

/**
 * The ONE label per shipment state. The Shipment card headline, the order badge and the SHIP
 * timeline all read it, and all decide "shipped" through `shipmentState`, so they can't disagree.
 */
export const SHIPMENT_STATE_LABEL: Record<ShipmentState, string> = {
  not_shipped: "Not shipped yet",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export const SHIP_STEP_LABELS = [
  "Confirmed",
  SHIPMENT_STATE_LABEL.shipped,
  SHIPMENT_STATE_LABEL.delivered,
] as const;
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
  const state = shipmentState(o);
  if (state === "delivered") return 2;
  if (state === "shipped") return 1;
  return state === "not_shipped" && o.status === "CONFIRMED" ? 0 : -1;
}

/** Index into NO_FLEET_STEP_LABELS (-1 = draft, or cancelled). */
export function noFleetStepIndex(status: string): number {
  if (status === "PENDING") return 0;
  if (status === "CONFIRMED" || DISPATCHED.includes(status)) return 1;
  return status === "DELIVERED" ? 2 : -1;
}

export function shipmentState(o: ShipFields): ShipmentState {
  if (o.status === "CANCELLED") return "cancelled";
  if (o.status === "DELIVERED") return "delivered";
  if (o.shippedAt || o.shippingTrackingNumber || DISPATCHED.includes(o.status)) return "shipped";
  return "not_shipped";
}

/** The order's status label when it differs from today's formatted status; null = today's. */
export function buyerStatusLabel(o: ShipFields, view: BuyerOrderTravelView): string | null {
  if (view === "shipment") {
    return shipmentState(o) === "shipped" ? SHIPMENT_STATE_LABEL.shipped : null;
  }
  if (view === "none") return o.status === "OUT_FOR_DELIVERY" ? "On Its Way" : null;
  return null;
}

/**
 * THE per-order status label (lead review M2): the order detail badge, the orders list and the
 * dashboard all call this, so one order reads the same everywhere. It is exactly
 * `buyerStatusLabel(order, orderTravelView(order.fulfillPath, cap, capLoading))` — a SHIP order of
 * a configured seller reads "Shipped" once shipped, a configured no-fleet seller's other orders
 * never say "Out For Delivery", and an unset / unread / loading capability is today's label
 * (null = today's formatted status).
 */
export function buyerOrderStatusLabel(
  o: ShipFields & { fulfillPath?: string | null },
  cap: BuyerSellerCapability | null | undefined,
  capLoading: boolean,
): string | null {
  return buyerStatusLabel(o, orderTravelView(o.fulfillPath, cap, capLoading));
}

/**
 * Order ahead (buyer portal): what the buyer is offered, from `GET /buyer/capabilities` (the one buyer capability source).
 * `[]` / `null` = no choice (today): nothing is sent and the server applies its own default.
 */
export interface BuyerFulfilmentChoice {
  /** more than one method: show the radio group */
  showChoice: boolean;
  methods: FulfilmentMethod[];
  /** the method preselected, and sent when the buyer does not choose; null = send nothing */
  defaultMethod: FulfilmentMethod | null;
}

export function buyerFulfilmentChoice(
  offer: Partial<Pick<BuyerSellerCapability, "portalMethods" | "portalDefault">> | null | undefined,
): BuyerFulfilmentChoice {
  const methods = [...(offer?.portalMethods ?? [])];
  const fallback = methods.length === 1 ? methods[0] : null;
  const preferred = offer?.portalDefault && methods.includes(offer.portalDefault);
  return {
    showChoice: methods.length > 1,
    methods,
    defaultMethod: preferred ? (offer?.portalDefault ?? null) : (fallback ?? methods[0] ?? null),
  };
}

export const FULFIL_METHOD_LABEL: Record<FulfilmentMethod, string> = {
  PICKUP: "Pick up at store",
  SHIP: "Ship to me",
  ROUTE: "Delivery",
};

export const FULFIL_METHOD_NOT_OFFERED_COPY =
  "That option isn't available from this seller any more. Choose another and try again.";

/** 400 FULFIL_METHOD_NOT_OFFERED: the seller changed its offer after the portal loaded. */
export function isFulfilMethodNotOffered(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)
    ?.response;
  return res?.status === 400 && res.data?.code === API_ERROR_CODES.FULFIL_METHOD_NOT_OFFERED;
}
