import * as React from "react";
import { render, screen } from "@testing-library/react";
import { orderStatusText } from "./order-status-label";
import { OrderStatusBadge } from "@/components/OrderStatusBadge";

// Display-only status words from the shared fulfilment table, per ORDER by its fulfillPath. An account
// with no fulfilment mode (unset capabilities) keeps today's words even for a SHIP order.
let fulfilment: Record<string, unknown> | undefined;
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({ data: fulfilment ? { capabilities: { fulfilment } } : undefined }),
}));

const shipAccount = {
  methods: ["SHIP"],
  staffDefault: "SHIP",
  portalMethods: [],
  portalDefault: null,
  counter: "off",
  fleet: false,
};
// A mixed account with a buyer choice at checkout (portalMethods non-empty). Without it the shape is
// identical to the UNSET account, which deliberately keeps today's words.
const mixedAccount = {
  ...shipAccount,
  methods: ["ROUTE", "SHIP"],
  staffDefault: "ROUTE",
  portalMethods: ["ROUTE", "SHIP"],
  portalDefault: "ROUTE",
  fleet: true,
};

describe("orderStatusText", () => {
  it("SHIP / PICKUP / ROUTE words, and the fallback for anything unlisted", () => {
    expect(orderStatusText("OUT_FOR_DELIVERY", "SHIP", "Out for Delivery")).toBe("Shipped");
    expect(orderStatusText("OUT_FOR_DELIVERY", "PICKUP", "x")).toBe("Ready for pickup");
    expect(orderStatusText("DELIVERED", "PICKUP", "Delivered")).toBe("Picked up");
    expect(orderStatusText("OUT_FOR_DELIVERY", "ROUTE", "x")).toBe("Out for Delivery");
    expect(orderStatusText("PENDING", "SHIP", "Pending")).toBe("Pending");
  });
});

describe("OrderStatusBadge", () => {
  it("unset account (no capabilities): today's wording, even for a SHIP order", () => {
    fulfilment = undefined;
    render(<OrderStatusBadge status="OUT_FOR_DELIVERY" fulfillPath="SHIP" />);
    expect(screen.getByText("Out for Delivery")).toBeInTheDocument();
  });

  it("shipping account: Shipped, other statuses untouched", () => {
    fulfilment = shipAccount;
    render(
      <>
        <OrderStatusBadge status="OUT_FOR_DELIVERY" />
        <OrderStatusBadge status="CONFIRMED" />
      </>,
    );
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    expect(screen.queryByText("Out for Delivery")).not.toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
  });

  it("mixed account: the word follows each ORDER's fulfillPath", () => {
    fulfilment = mixedAccount;
    render(
      <>
        <OrderStatusBadge status="OUT_FOR_DELIVERY" fulfillPath="SHIP" />
        <OrderStatusBadge status="OUT_FOR_DELIVERY" fulfillPath="ROUTE" />
        <OrderStatusBadge status="OUT_FOR_DELIVERY" fulfillPath="PICKUP" />
      </>,
    );
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    expect(screen.getByText("Out for Delivery")).toBeInTheDocument();
    expect(screen.getByText("Ready for pickup")).toBeInTheDocument();
  });
});
