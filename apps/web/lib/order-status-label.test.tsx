import * as React from "react";
import { render, screen } from "@testing-library/react";
import { orderStatusLabelOverride, orderStatusText } from "./order-status-label";
import { OrderStatusBadge } from "@/components/OrderStatusBadge";

// Display-only: an account in SHIP fulfilment mode reads "Shipped" for Out for Delivery on staff
// screens. Every other account and every other status render exactly as before.
let ship = false;
jest.mock("@/lib/ship-mode", () => ({ useShipMode: () => ship }));

describe("orderStatusLabelOverride / orderStatusText", () => {
  it("ship-mode OUT_FOR_DELIVERY reads Shipped", () => {
    expect(orderStatusLabelOverride("OUT_FOR_DELIVERY", true)).toBe("Shipped");
    expect(orderStatusText("OUT_FOR_DELIVERY", true, "Out for Delivery")).toBe("Shipped");
  });
  it("a non-ship account is untouched", () => {
    expect(orderStatusLabelOverride("OUT_FOR_DELIVERY", false)).toBeUndefined();
    expect(orderStatusText("OUT_FOR_DELIVERY", false, "Out for Delivery")).toBe("Out for Delivery");
  });
  it.each(["PENDING", "CONFIRMED", "DELIVERED", "CANCELLED", "PARTIALLY_DELIVERED", ""])(
    "no other status (%p) is ever renamed",
    (s) => {
      expect(orderStatusLabelOverride(s, true)).toBeUndefined();
      expect(orderStatusText(s, true, "Normal")).toBe("Normal");
    },
  );
});

describe("OrderStatusBadge", () => {
  it("not ship mode: Out for Delivery, today's label", () => {
    ship = false;
    render(<OrderStatusBadge status="OUT_FOR_DELIVERY" />);
    expect(screen.getByText("Out for Delivery")).toBeInTheDocument();
  });
  it("ship mode: Shipped, and the enum is untouched elsewhere", () => {
    ship = true;
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
});
