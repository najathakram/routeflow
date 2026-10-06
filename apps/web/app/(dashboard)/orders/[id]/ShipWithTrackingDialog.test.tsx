import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { ShipWithTrackingDialog } from "./ShipWithTrackingDialog";
import { shipWithTracking } from "@/lib/ship-with-tracking";

// F4: "Mark shipped" on a SHIP order asks for tracking first, so the customer gets ONE shipped
// email that carries it. With tracking the shipment is saved BEFORE the ship (status) call.

function setup(
  saveImpl: () => Promise<unknown> = async () => undefined,
  saved: { carrier?: string | null; tracking?: string | null } = {},
) {
  const save = jest.fn(saveImpl);
  const ship = jest.fn();
  const onClose = jest.fn();
  render(
    <ToastProvider>
      <ShipWithTrackingDialog
        open
        onClose={onClose}
        initialCarrier={saved.carrier}
        initialTracking={saved.tracking}
        onShipWithTracking={(values) => shipWithTracking({ saveShipment: save, ship }, values)}
        onSkip={ship}
      />
    </ToastProvider>,
  );
  return { save, ship, onClose };
}

const trackingInput = () => screen.getByLabelText("Tracking number");

describe("ShipWithTrackingDialog (F4)", () => {
  it("shows the approved copy", () => {
    setup();
    expect(screen.getByText("Add tracking (optional)")).toBeTruthy();
    expect(screen.getByLabelText("Carrier")).toBeTruthy();
    expect(trackingInput()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ship with tracking" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip, ship now" })).toBeTruthy();
  });

  it("with tracking: the shipment PATCH runs first, then the ship (status) call", async () => {
    const { save, ship } = setup();
    fireEvent.change(trackingInput(), { target: { value: " 1Z999 " } });
    fireEvent.click(screen.getByRole("button", { name: "Ship with tracking" }));
    await waitFor(() => expect(ship).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ shippingCarrier: "ups", shippingTrackingNumber: "1Z999" });
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(ship.mock.invocationCallOrder[0]);
  });

  it("'Ship with tracking' is disabled until a tracking number is typed", () => {
    setup();
    expect(
      (screen.getByRole("button", { name: "Ship with tracking" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("'Skip, ship now' ships exactly as today: no shipment save", async () => {
    const { save, ship } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Skip, ship now" }));
    await waitFor(() => expect(ship).toHaveBeenCalledTimes(1));
    expect(save).not.toHaveBeenCalled();
  });

  it("a failed shipment save never ships the order", async () => {
    const { save, ship } = setup(async () => {
      throw new Error("boom");
    });
    fireEvent.change(trackingInput(), { target: { value: "1Z999" } });
    fireEvent.click(screen.getByRole("button", { name: "Ship with tracking" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(ship).not.toHaveBeenCalled();
  });

  describe("pre-fill from the saved shipment", () => {
    const carrierSelect = () => screen.getByLabelText("Carrier") as HTMLSelectElement;
    const trackingField = () => trackingInput() as HTMLInputElement;

    it("shows the saved carrier and tracking number", () => {
      setup(undefined, { carrier: "fedex", tracking: "794644790138" });
      expect(carrierSelect().value).toBe("fedex");
      expect(trackingField().value).toBe("794644790138");
      expect(
        (screen.getByRole("button", { name: "Ship with tracking" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    it("maps a legacy free-text carrier label onto its picker option", () => {
      setup(undefined, { carrier: "FedEx", tracking: "794" });
      expect(carrierSelect().value).toBe("fedex");
    });

    it("an unrecognised carrier lands on Other, never silently on UPS", () => {
      setup(undefined, { carrier: "Local Courier", tracking: "A-1" });
      expect(carrierSelect().value).toBe("other");
    });

    it("nothing saved: UPS and an empty tracking field, as before", () => {
      setup(undefined, { carrier: null, tracking: null });
      expect(carrierSelect().value).toBe("ups");
      expect(trackingField().value).toBe("");
    });

    it("ships with the pre-filled values untouched", async () => {
      const { save, ship } = setup(undefined, { carrier: "dhl", tracking: "JD0146" });
      fireEvent.click(screen.getByRole("button", { name: "Ship with tracking" }));
      await waitFor(() => expect(ship).toHaveBeenCalledTimes(1));
      expect(save).toHaveBeenCalledWith({
        shippingCarrier: "dhl",
        shippingTrackingNumber: "JD0146",
      });
    });
  });
});
