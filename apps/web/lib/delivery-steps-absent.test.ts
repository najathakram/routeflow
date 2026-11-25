import {
  DELIVERY_STEPS_ABSENT_COPY,
  UNSET_FULFILMENT_CAPABILITIES,
  deliveryStepsAbsentReason,
  isPosOrder,
  type FulfilmentCapability,
} from "@routeflow/types";

const cap = (over: Partial<FulfilmentCapability>): FulfilmentCapability => ({
  methods: ["ROUTE"],
  staffDefault: "ROUTE",
  staffOpensAs: "order",
  portalMethods: ["ROUTE"],
  portalDefault: "ROUTE",
  counter: "off",
  fleet: true,
  consistent: true,
  ...over,
});

const deliveryWithFleet = cap({});
const deliveryNoFleet = cap({ fleet: false, consistent: false });
const pickupTenant = cap({
  methods: ["PICKUP"],
  staffDefault: "PICKUP",
  staffOpensAs: "counter",
  portalMethods: ["PICKUP"],
  portalDefault: "PICKUP",
  counter: "always",
});
const pickupShipTenant = cap({ methods: ["PICKUP", "SHIP"], staffDefault: "PICKUP" });

describe("deliveryStepsAbsentReason (W-1306): one answer for every hidden delivery step", () => {
  const table: Array<[string, Parameters<typeof deliveryStepsAbsentReason>[0], string | null]> = [
    [
      "ROUTE order of a fleet tenant: steps shown",
      { fulfillPath: "ROUTE", capability: deliveryWithFleet },
      null,
    ],
    [
      "order with no path on an unset account: today's ROUTE, shown",
      { fulfillPath: undefined, capability: UNSET_FULFILMENT_CAPABILITIES },
      null,
    ],
    [
      "no capability read yet, ROUTE order: shown",
      { fulfillPath: "ROUTE", capability: null },
      null,
    ],
    [
      "SHIP order of a no-fleet tenant: its own ship steps, shown",
      { fulfillPath: "SHIP", capability: deliveryNoFleet },
      null,
    ],
    [
      "counter sale: its own one-step flow, no reason",
      { fulfillPath: "PICKUP", counterSale: true, capability: pickupTenant },
      null,
    ],
    [
      "PICKUP order of a pickup business",
      { fulfillPath: "PICKUP", counterSale: false, capability: pickupTenant },
      "PICKUP_MODEL",
    ],
    [
      "PICKUP order of a pickup_ship business",
      { fulfillPath: "PICKUP", capability: pickupShipTenant },
      "PICKUP_MODEL",
    ],
    [
      "PICKUP order of a delivery business, staff view: POS mode by elimination",
      { fulfillPath: "PICKUP", counterSale: null, capability: deliveryWithFleet },
      "POS_MODE",
    ],
    [
      "PICKUP order on an unset account, staff view: POS mode by elimination",
      { fulfillPath: "PICKUP", capability: UNSET_FULFILMENT_CAPABILITIES },
      "POS_MODE",
    ],
    [
      "PICKUP order with no staff facts (buyer or unread): the customer's path",
      { fulfillPath: "PICKUP", capability: null },
      "CUSTOMER_PICKUP",
    ],
    [
      "ROUTE order of a configured seller with no fleet",
      { fulfillPath: "ROUTE", capability: deliveryNoFleet },
      "NO_FLEET",
    ],
    [
      "buyer capability: configured seller, no fleet, no path",
      { fulfillPath: null, capability: { portalDefault: "ROUTE", fleet: false } },
      "NO_FLEET",
    ],
    [
      "buyer capability: unset seller (portalDefault null) never reads NO_FLEET",
      { fulfillPath: "ROUTE", capability: { portalDefault: null, fleet: false } },
      null,
    ],
  ];
  it.each(table)("%s", (_name, input, expected) => {
    expect(deliveryStepsAbsentReason(input)).toBe(expected);
  });

  it("every reason has copy that names where to fix it", () => {
    expect(DELIVERY_STEPS_ABSENT_COPY.PICKUP_MODEL).toBe(
      "This business is set up for pickup only. To deliver, go to Settings > Fulfillment.",
    );
    expect(DELIVERY_STEPS_ABSENT_COPY.POS_MODE).toBe(
      "This order is pickup. To deliver, change Fulfillment to Delivery.",
    );
    expect(DELIVERY_STEPS_ABSENT_COPY.CUSTOMER_PICKUP).toBe(DELIVERY_STEPS_ABSENT_COPY.POS_MODE);
    expect(DELIVERY_STEPS_ABSENT_COPY.NO_FLEET).toBe(
      "Delivery tracking is off. Turn on the delivery add-on to see each step.",
    );
  });
});

describe("isPosOrder (the one copy)", () => {
  it("PICKUP and not a counter sale", () => {
    expect(isPosOrder({ fulfillPath: "PICKUP" })).toBe(true);
    expect(isPosOrder({ fulfillPath: "PICKUP", counterSale: false })).toBe(true);
    expect(isPosOrder({ fulfillPath: "PICKUP", counterSale: true })).toBe(false);
    expect(isPosOrder({ fulfillPath: "ROUTE" })).toBe(false);
    expect(isPosOrder(null)).toBe(false);
  });
});
