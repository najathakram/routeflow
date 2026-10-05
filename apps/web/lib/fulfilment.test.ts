import {
  FULFILMENT_METHODS,
  UNSET_FULFILMENT_CAPABILITIES,
  fulfilmentStatusLabel,
  preselectFulfilment,
} from "@routeflow/types";

describe("FULFILMENT_METHODS", () => {
  it("ROUTE keeps today's words", () => {
    expect(fulfilmentStatusLabel("ROUTE", "OUT_FOR_DELIVERY", "x")).toBe("Out for Delivery");
    expect(fulfilmentStatusLabel("ROUTE", "DELIVERED", "x")).toBe("Delivered");
  });
  it("SHIP says Shipped; PICKUP says Ready for pickup / Picked up", () => {
    expect(fulfilmentStatusLabel("SHIP", "OUT_FOR_DELIVERY", "x")).toBe("Shipped");
    expect(fulfilmentStatusLabel("PICKUP", "OUT_FOR_DELIVERY", "x")).toBe("Ready for pickup");
    expect(fulfilmentStatusLabel("PICKUP", "DELIVERED", "x")).toBe("Picked up");
  });
  it("an unlisted status or an unknown / missing method falls back to the caller's label", () => {
    expect(fulfilmentStatusLabel("SHIP", "PENDING", "Pending")).toBe("Pending");
    expect(fulfilmentStatusLabel("NOPE", "OUT_FOR_DELIVERY", "Out for Delivery")).toBe(
      "Out for Delivery",
    );
    expect(fulfilmentStatusLabel(undefined, "DELIVERED", "Delivered")).toBe("Delivered");
  });
  it("pins the steps per method, and the table is display-only (no billing moment, no email events)", () => {
    for (const m of Object.values(FULFILMENT_METHODS)) {
      expect(m.steps).toEqual(["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"]);
      // the api owns when an order is invoiced and which email fires (billsAtShipment, the registry)
      expect(Object.keys(m).sort()).toEqual(["labels", "steps"]);
    }
  });
});

describe("preselectFulfilment (customer first, then the account default)", () => {
  const shipOnly = { methods: ["SHIP" as const], staffDefault: "SHIP" as const };
  it("unset account: the customer's saved path, else ROUTE (today)", () => {
    expect(preselectFulfilment(UNSET_FULFILMENT_CAPABILITIES, "SHIP")).toBe("SHIP");
    expect(preselectFulfilment(UNSET_FULFILMENT_CAPABILITIES, "ROUTE")).toBe("ROUTE");
    expect(preselectFulfilment(UNSET_FULFILMENT_CAPABILITIES, null)).toBe("ROUTE");
  });
  it("a path the account does not offer falls back to staffDefault", () => {
    expect(preselectFulfilment(shipOnly, "ROUTE")).toBe("SHIP");
    expect(preselectFulfilment(shipOnly, undefined)).toBe("SHIP");
  });
  it("a path the account offers wins over staffDefault", () => {
    expect(preselectFulfilment({ methods: ["ROUTE", "SHIP"], staffDefault: "SHIP" }, "ROUTE")).toBe(
      "ROUTE",
    );
  });
});
