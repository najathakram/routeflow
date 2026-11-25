import { DELIVERY_STEPS_ABSENT_COPY } from "@routeflow/types/api/fulfilment";
import { staffDeliveryAbsentNote } from "../lib/fulfilment-caps";

type FeaturesArg = Parameters<typeof staffDeliveryAbsentNote>[0];

const features = (over: Record<string, unknown>) =>
  ({
    capabilities: {
      fulfilment: {
        methods: ["ROUTE"],
        staffDefault: "ROUTE",
        staffOpensAs: "order",
        portalMethods: ["ROUTE"],
        portalDefault: "ROUTE",
        counter: "off",
        fleet: true,
        consistent: true,
        ...over,
      },
    },
  }) as FeaturesArg;

describe("staffDeliveryAbsentNote (W-1306): mobile reads the one helper", () => {
  it("null for a ROUTE order of a fleet business, and while the answer is unread", () => {
    expect(staffDeliveryAbsentNote(features({}), { fulfillPath: "ROUTE" })).toBeNull();
    expect(staffDeliveryAbsentNote(undefined, { fulfillPath: "ROUTE" })).toBeNull();
  });
  it("PICKUP_MODEL for a pickup business", () => {
    const f = features({ methods: ["PICKUP"], staffDefault: "PICKUP", counter: "always" });
    expect(staffDeliveryAbsentNote(f, { fulfillPath: "PICKUP", counterSale: false })).toBe(
      DELIVERY_STEPS_ABSENT_COPY.PICKUP_MODEL,
    );
  });
  it("POS_MODE for a PICKUP order of a delivery business; unread answer is the same (unset)", () => {
    expect(staffDeliveryAbsentNote(features({}), { fulfillPath: "PICKUP" })).toBe(
      DELIVERY_STEPS_ABSENT_COPY.POS_MODE,
    );
    expect(staffDeliveryAbsentNote(undefined, { fulfillPath: "PICKUP" })).toBe(
      DELIVERY_STEPS_ABSENT_COPY.POS_MODE,
    );
  });
  it("null for a counter sale", () => {
    expect(
      staffDeliveryAbsentNote(features({ methods: ["PICKUP"] }), {
        fulfillPath: "PICKUP",
        counterSale: true,
      }),
    ).toBeNull();
  });
});
