import { render, screen } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { ShipmentCard } from "./ShipmentCard";

const SHIPPED_AT = "2026-06-20T12:00:00.000Z";

function card(orderStatus?: string | null) {
  return (
    <ToastProvider>
      <ShipmentCard
        carrier="ups"
        trackingNumber="1Z999"
        shippedAt={SHIPPED_AT}
        orderStatus={orderStatus}
        onSave={async () => undefined}
      />
    </ToastProvider>
  );
}

describe("ShipmentCard shipped date (F10a)", () => {
  it.each(["CONFIRMED", "PENDING"])(
    "an unmarked order (%s) shows no 'Shipped <date>' line, though shippedAt survives",
    (status) => {
      render(card(status));
      expect(screen.getByText("1Z999")).toBeTruthy();
      expect(screen.queryByText(/^Shipped /)).toBeNull();
    },
  );

  it.each(["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED"])(
    "a shipped order (%s) keeps the date",
    (status) => {
      render(card(status));
      expect(screen.getByText(/^Shipped /)).toBeTruthy();
    },
  );

  it("unchanged: no order status given (standalone invoice) keeps the date", () => {
    render(card(undefined));
    expect(screen.getByText(/^Shipped /)).toBeTruthy();
  });
});
