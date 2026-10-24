import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { CARRIER_HINT, needsCarrierHint, shipmentSaveDecision } from "@routeflow/types";
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

describe("ShipmentCard save feedback (M8c)", () => {
  function editable(props: Partial<React.ComponentProps<typeof ShipmentCard>>) {
    const onSave = jest.fn(async () => undefined);
    render(
      <ToastProvider>
        <ShipmentCard onSave={onSave} {...props} />
      </ToastProvider>,
    );
    return onSave;
  }

  it("saving an empty form on an order with no shipment toasts nothing and does not call the API", async () => {
    const onSave = editable({ carrier: null, trackingNumber: null });
    fireEvent.click(screen.getByRole("button", { name: /Add tracking/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText("Shipment tracking")).toBeNull());
    expect(screen.queryByText("Shipment cleared")).toBeNull();
    expect(screen.queryByText("Shipment saved")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  const pickCarrier = (v: string) =>
    fireEvent.change(screen.getByRole("combobox"), { target: { value: v } });

  it("emptying BOTH the number and the carrier of a stored shipment clears it: 'Shipment cleared'", async () => {
    const onSave = editable({ carrier: "ups", trackingNumber: "1Z999" });
    fireEvent.click(screen.getByRole("button", { name: /Edit shipment/ }));
    fireEvent.change(screen.getByPlaceholderText(/1Z999AA/), { target: { value: "" } });
    pickCarrier("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Shipment cleared")).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledWith({ shippingCarrier: "", shippingTrackingNumber: "" });
  });

  it("a carrier alone SAVES on a new shipment (no tracking number needed)", async () => {
    const onSave = editable({ carrier: null, trackingNumber: null });
    fireEvent.click(screen.getByRole("button", { name: /Add tracking/ }));
    pickCarrier("fedex");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Shipment saved")).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledWith({ shippingCarrier: "fedex", shippingTrackingNumber: "" });
  });

  it("a legacy carrier-only row shows as a shipment and a plain save KEEPS the carrier", async () => {
    const onSave = editable({ carrier: "ups", trackingNumber: null });
    expect(screen.queryByText("No carrier shipment recorded.")).toBeNull();
    expect(screen.getByText("UPS")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Edit shipment/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Shipment saved")).toBeInTheDocument();
    expect(screen.queryByText("Shipment cleared")).toBeNull();
    expect(onSave).toHaveBeenCalledWith({ shippingCarrier: "ups", shippingTrackingNumber: "" });
  });

  it("typing a tracking number leaves the carrier at No carrier, shows the hint, and saves the number with no carrier", async () => {
    const onSave = editable({ carrier: null, trackingNumber: null });
    fireEvent.click(screen.getByRole("button", { name: /Add tracking/ }));
    expect(screen.queryByText(CARRIER_HINT)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/1Z999AA/), { target: { value: "1Z123" } });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
    expect(screen.getByText(CARRIER_HINT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Shipment saved");
    expect(onSave).toHaveBeenCalledWith({ shippingCarrier: "", shippingTrackingNumber: "1Z123" });
  });

  it("the hint goes away once a carrier is picked", () => {
    editable({ carrier: null, trackingNumber: null });
    fireEvent.click(screen.getByRole("button", { name: /Add tracking/ }));
    fireEvent.change(screen.getByPlaceholderText(/1Z999AA/), { target: { value: "1Z123" } });
    expect(screen.getByText(CARRIER_HINT)).toBeInTheDocument();
    pickCarrier("ups");
    expect(screen.queryByText(CARRIER_HINT)).toBeNull();
  });

  it("a saved tracking number with no carrier shows as text, with no tracking link", () => {
    editable({ carrier: null, trackingNumber: "1Z999" });
    expect(screen.getByText("1Z999")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("a real tracking number toasts 'Shipment saved'", async () => {
    editable({ carrier: null, trackingNumber: null });
    fireEvent.click(screen.getByRole("button", { name: /Add tracking/ }));
    fireEvent.change(screen.getByPlaceholderText(/1Z999AA/), { target: { value: "1Z123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Shipment saved")).toBeInTheDocument();
  });
});

describe("ShipmentCard says whether it has shipped (M8d)", () => {
  const withStatus = (
    orderStatus: string,
    fulfillPath: string | null = "SHIP",
    customerNotified?: boolean,
  ) =>
    render(
      <ToastProvider>
        <ShipmentCard
          carrier="ups"
          trackingNumber="1Z999"
          orderStatus={orderStatus}
          fulfillPath={fulfillPath}
          customerNotified={customerNotified}
          onSave={async () => undefined}
        />
      </ToastProvider>,
    );

  it.each(["PENDING", "CONFIRMED"])(
    "a SHIP order that is %s with saved tracking says it has not shipped yet",
    (status) => {
      withStatus(status);
      expect(screen.getByText(/Not shipped yet/)).toBeInTheDocument();
    },
  );

  it("claims the customer is told only while the order-shipped notification is on", () => {
    const { unmount } = withStatus("PENDING", "SHIP", true);
    expect(screen.getByText(/^Not shipped yet\./)).toHaveTextContent(
      "Not shipped yet. The customer is told when you mark the order shipped.",
    );
    unmount();
    withStatus("PENDING", "SHIP", false);
    expect(screen.getByText(/^Not shipped yet\./)).toHaveTextContent(/^Not shipped yet\.$/);
  });

  it.each(["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"])("%s: no 'not shipped' line", (status) => {
    withStatus(status);
    expect(screen.queryByText(/Not shipped yet/)).toBeNull();
  });

  it("a carrier-only shipment on a SHIP order that has not shipped says so too", () => {
    render(
      <ToastProvider>
        <ShipmentCard
          carrier="ups"
          trackingNumber={null}
          orderStatus="PENDING"
          fulfillPath="SHIP"
          onSave={async () => undefined}
        />
      </ToastProvider>,
    );
    expect(screen.getByText(/^Not shipped yet\./)).toBeInTheDocument();
  });

  it("no fulfillPath (invoice page) or a non-SHIP order: unchanged, no line", () => {
    withStatus("PENDING", null);
    expect(screen.queryByText(/Not shipped yet/)).toBeNull();
  });
});

// The SAME three outcomes are pinned on mobile in apps/mobile/__tests__/shipment-display.test.ts: both apps
// call this one rule.
describe("shipmentSaveDecision (shared with mobile)", () => {
  it("a carrier and/or a number saves; both empty clears a stored shipment or does nothing", () => {
    expect(shipmentSaveDecision({}, "ups", "")).toEqual({
      outcome: "saved",
      payload: { shippingCarrier: "ups", shippingTrackingNumber: "" },
    });
    expect(shipmentSaveDecision({}, "", "1Z")).toEqual({
      outcome: "saved",
      payload: { shippingCarrier: "", shippingTrackingNumber: "1Z" },
    });
    expect(shipmentSaveDecision({ shippingCarrier: "ups" }, " ", " ")).toEqual({
      outcome: "cleared",
      payload: { shippingCarrier: "", shippingTrackingNumber: "" },
    });
    expect(shipmentSaveDecision({}, "", "")).toEqual({ outcome: "nothing", payload: null });
  });
});

describe("needsCarrierHint (shared with mobile)", () => {
  it("only when a tracking number is entered with no carrier", () => {
    expect(needsCarrierHint("", "1Z")).toBe(true);
    expect(needsCarrierHint("  ", " 1Z ")).toBe(true);
    expect(needsCarrierHint("ups", "1Z")).toBe(false);
    expect(needsCarrierHint("", "")).toBe(false);
    expect(needsCarrierHint("", "  ")).toBe(false);
  });
});
