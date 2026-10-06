import { shipmentForDisplay } from "../lib/shipment-display";

const shipment = {
  shippingCarrier: "ups",
  shippingTrackingNumber: "1Z999",
  shippedAt: "2026-06-20",
};

describe("shipmentForDisplay (F10a)", () => {
  it.each(["CONFIRMED", "PENDING"])("an unmarked order (%s) shows no shipped date", (status) => {
    const out = shipmentForDisplay(shipment, status);
    expect(out.shippedAt).toBeNull();
    expect(out.shippingTrackingNumber).toBe("1Z999");
  });

  it.each(["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED"])(
    "a shipped order (%s) keeps the date",
    (status) => {
      expect(shipmentForDisplay(shipment, status)).toBe(shipment);
    },
  );

  it("unchanged: no order status (standalone invoice) keeps the date", () => {
    expect(shipmentForDisplay(shipment, undefined)).toBe(shipment);
    expect(shipmentForDisplay(shipment, null)).toBe(shipment);
  });
});
