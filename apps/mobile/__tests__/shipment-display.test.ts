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

import { shipmentNotShippedNote, shipmentSaveOutcome } from "../lib/shipment-display";

describe("shipmentSaveOutcome (M8c)", () => {
  it("blank over nothing stored changes nothing: no 'cleared'", () => {
    expect(shipmentSaveOutcome({}, "", "")).toBe("nothing");
    expect(
      shipmentSaveOutcome({ shippingCarrier: null, shippingTrackingNumber: " " }, " ", ""),
    ).toBe("nothing");
  });
  it("blank over a stored shipment is 'cleared'", () => {
    expect(shipmentSaveOutcome({ shippingTrackingNumber: "1Z999" }, "", "")).toBe("cleared");
    expect(shipmentSaveOutcome({ shippingCarrier: "UPS" }, "", "")).toBe("cleared");
  });
  it("a carrier or a number is 'saved'", () => {
    expect(shipmentSaveOutcome({}, "UPS", "")).toBe("saved");
    expect(shipmentSaveOutcome({}, "", "1Z999")).toBe("saved");
  });
});

describe("shipmentNotShippedNote (M8d)", () => {
  it.each(["PENDING", "CONFIRMED", "DRAFT"])(
    "a SHIP order that is %s with tracking says so",
    (s) => {
      expect(shipmentNotShippedNote("SHIP", s, "1Z999")).toMatch(/^Not shipped yet/);
    },
  );
  it.each(["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"])("%s: no note", (s) => {
    expect(shipmentNotShippedNote("SHIP", s, "1Z999")).toBeNull();
  });
  it("no tracking, not SHIP, or no status: no note", () => {
    expect(shipmentNotShippedNote("SHIP", "PENDING", "")).toBeNull();
    expect(shipmentNotShippedNote("ROUTE", "PENDING", "1Z999")).toBeNull();
    expect(shipmentNotShippedNote("SHIP", undefined, "1Z999")).toBeNull();
  });
});
