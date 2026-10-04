import type { BuyerSellerCapability } from "@routeflow/types";
import {
  NO_FLEET_STEP_LABELS,
  SHIPMENT_STATE_LABEL,
  SHIP_STEP_LABELS,
  buyerListStatusLabel,
  buyerStatusLabel,
  isConfiguredSeller,
  noFleetStepIndex,
  orderTravelView,
  sellerShowsRouteWording,
  shipStepIndex,
  shipmentState,
} from "./buyer-fulfilment";

/**
 * Business profiles 1B — what a buyer sees about how an order travels, read from the SELLER's
 * fulfilment capability (`GET /buyer/capabilities`). An unset seller (portalDefault null), or a
 * capability that could not be read, is today's screen exactly.
 */
function cap(over: Partial<BuyerSellerCapability> = {}): BuyerSellerCapability {
  return { portalMethods: ["SHIP"], portalDefault: "SHIP", fleet: false, ...over };
}
const UNSET_NO_FLEET = cap({
  portalMethods: [],
  portalDefault: null,
  fleet: false,
});
const UNSET_FLEET = { ...UNSET_NO_FLEET, fleet: true };
const SHIP_ONLY = cap();
const BOTH_FLEET = cap({
  portalMethods: ["ROUTE", "SHIP"],
  portalDefault: "ROUTE",
  fleet: true,
});

describe("isConfiguredSeller / sellerShowsRouteWording", () => {
  it("unset sellers are not configured and keep today's route wording, fleet or not", () => {
    expect(isConfiguredSeller(UNSET_NO_FLEET)).toBe(false);
    expect(sellerShowsRouteWording(UNSET_NO_FLEET)).toBe(true);
    expect(sellerShowsRouteWording(UNSET_FLEET)).toBe(true);
  });

  it("an unread capability (loading or failed) is today's wording", () => {
    expect(sellerShowsRouteWording(undefined)).toBe(true);
    expect(sellerShowsRouteWording(null)).toBe(true);
  });

  it("a configured seller shows route wording only when it has a fleet", () => {
    expect(isConfiguredSeller(SHIP_ONLY)).toBe(true);
    expect(sellerShowsRouteWording(SHIP_ONLY)).toBe(false);
    expect(sellerShowsRouteWording(BOTH_FLEET)).toBe(true);
  });
});

describe("orderTravelView", () => {
  it("waits for the capability before choosing (no route card flashes for a ship seller)", () => {
    expect(orderTravelView("SHIP", undefined, true)).toBe("loading");
  });

  it("unset seller or unreadable capability: today's route view, SHIP orders included", () => {
    expect(orderTravelView("ROUTE", UNSET_NO_FLEET, false)).toBe("route");
    expect(orderTravelView("SHIP", UNSET_NO_FLEET, false)).toBe("route");
    expect(orderTravelView("SHIP", undefined, false)).toBe("route");
  });

  it("configured seller: a SHIP order is a shipment", () => {
    expect(orderTravelView("SHIP", SHIP_ONLY, false)).toBe("shipment");
    expect(orderTravelView("SHIP", BOTH_FLEET, false)).toBe("shipment");
  });

  it("configured seller: a ROUTE order is the route view only with a fleet", () => {
    expect(orderTravelView("ROUTE", BOTH_FLEET, false)).toBe("route");
    expect(orderTravelView("ROUTE", SHIP_ONLY, false)).toBe("none");
    expect(orderTravelView(undefined, SHIP_ONLY, false)).toBe("none");
  });
});

describe("the SHIP timeline (Confirmed → Shipped → Delivered)", () => {
  it("has exactly the three shipping steps", () => {
    expect(SHIP_STEP_LABELS).toEqual(["Confirmed", "Shipped", "Delivered"]);
  });

  it("places the order on it", () => {
    expect(shipStepIndex({ status: "PENDING" })).toBe(-1);
    expect(shipStepIndex({ status: "CONFIRMED", shippedAt: null })).toBe(0);
    expect(shipStepIndex({ status: "CONFIRMED", shippedAt: "2026-10-01T10:00:00Z" })).toBe(1);
    expect(shipStepIndex({ status: "OUT_FOR_DELIVERY" })).toBe(1);
    expect(shipStepIndex({ status: "PARTIALLY_DELIVERED" })).toBe(1);
    expect(shipStepIndex({ status: "DELIVERED" })).toBe(2);
    expect(shipStepIndex({ status: "CANCELLED", shippedAt: null })).toBe(-1);
  });
});

describe("the no-fleet timeline (Pending → Confirmed → Delivered)", () => {
  it("has no route steps", () => {
    expect(NO_FLEET_STEP_LABELS).toEqual(["Pending", "Confirmed", "Delivered"]);
  });

  it("places the order on it", () => {
    expect(noFleetStepIndex("DRAFT")).toBe(-1);
    expect(noFleetStepIndex("PENDING")).toBe(0);
    expect(noFleetStepIndex("CONFIRMED")).toBe(1);
    expect(noFleetStepIndex("OUT_FOR_DELIVERY")).toBe(1);
    expect(noFleetStepIndex("PARTIALLY_DELIVERED")).toBe(1);
    expect(noFleetStepIndex("DELIVERED")).toBe(2);
    expect(noFleetStepIndex("CANCELLED")).toBe(-1);
  });
});

describe("shipmentState", () => {
  it("reads shipped from shippedAt, a tracking number, or a dispatched status", () => {
    expect(shipmentState({ status: "CONFIRMED" })).toBe("not_shipped");
    expect(shipmentState({ status: "CONFIRMED", shippedAt: "2026-10-01T10:00:00Z" })).toBe(
      "shipped",
    );
    expect(shipmentState({ status: "CONFIRMED", shippingTrackingNumber: "1Z999" })).toBe("shipped");
    expect(shipmentState({ status: "OUT_FOR_DELIVERY" })).toBe("shipped");
    expect(shipmentState({ status: "DELIVERED" })).toBe("delivered");
    expect(shipmentState({ status: "CANCELLED", shippedAt: "2026-10-01T10:00:00Z" })).toBe(
      "cancelled",
    );
  });
});

describe("buyerStatusLabel (null = today's formatted status)", () => {
  it("route view and loading never relabel", () => {
    expect(buyerStatusLabel({ status: "OUT_FOR_DELIVERY" }, "route")).toBeNull();
    expect(buyerStatusLabel({ status: "OUT_FOR_DELIVERY" }, "loading")).toBeNull();
  });

  it("a shipment says Shipped instead of Out For Delivery or a shipped Confirmed", () => {
    expect(buyerStatusLabel({ status: "OUT_FOR_DELIVERY" }, "shipment")).toBe("Shipped");
    expect(
      buyerStatusLabel({ status: "CONFIRMED", shippedAt: "2026-10-01T10:00:00Z" }, "shipment"),
    ).toBe("Shipped");
    expect(buyerStatusLabel({ status: "CONFIRMED" }, "shipment")).toBeNull();
    expect(buyerStatusLabel({ status: "DELIVERED" }, "shipment")).toBeNull();
  });

  it("a no-fleet seller never says Out For Delivery", () => {
    expect(buyerStatusLabel({ status: "OUT_FOR_DELIVERY" }, "none")).toBe("On Its Way");
    expect(buyerStatusLabel({ status: "CONFIRMED" }, "none")).toBeNull();
  });
});

describe("buyerListStatusLabel (orders list, dashboard)", () => {
  it("relabels Out For Delivery only for a configured seller without a fleet", () => {
    expect(buyerListStatusLabel("OUT_FOR_DELIVERY", SHIP_ONLY)).toBe("On Its Way");
    expect(buyerListStatusLabel("CONFIRMED", SHIP_ONLY)).toBeNull();
    expect(buyerListStatusLabel("OUT_FOR_DELIVERY", BOTH_FLEET)).toBeNull();
    expect(buyerListStatusLabel("OUT_FOR_DELIVERY", UNSET_NO_FLEET)).toBeNull();
    expect(buyerListStatusLabel("OUT_FOR_DELIVERY", undefined)).toBeNull();
  });
});

describe("one 'Shipped' answer: the card, the badge and the timeline agree (lead review nit)", () => {
  const ORDERS = [
    { status: "PENDING" },
    { status: "CONFIRMED" },
    { status: "CONFIRMED", shippedAt: "2026-10-01T10:00:00Z" },
    { status: "CONFIRMED", shippingTrackingNumber: "1Z999" },
    { status: "OUT_FOR_DELIVERY" },
    { status: "PARTIALLY_DELIVERED" },
    { status: "DELIVERED", shippedAt: "2026-10-01T10:00:00Z" },
    { status: "CANCELLED", shippedAt: "2026-10-01T10:00:00Z" },
  ];

  it.each(ORDERS)("%o", (o) => {
    const shipped = shipmentState(o) === "shipped";
    expect(buyerStatusLabel(o, "shipment") === SHIPMENT_STATE_LABEL.shipped).toBe(shipped);
    expect(shipStepIndex(o) === 1).toBe(shipped);
    expect(SHIP_STEP_LABELS[1]).toBe(SHIPMENT_STATE_LABEL.shipped);
  });

  it("the one label set", () => {
    expect(SHIPMENT_STATE_LABEL).toEqual({
      not_shipped: "Not shipped yet",
      shipped: "Shipped",
      delivered: "Delivered",
      cancelled: "Cancelled",
    });
  });
});
