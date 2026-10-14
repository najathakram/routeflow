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

import { shipmentNotShippedNote } from "../lib/shipment-display";
import { shipmentSaveDecision } from "@routeflow/types/shipment-save";

// The SAME table is pinned on web in apps/web/components/ShipmentCard.test.tsx (carrier-only saves, M8):
// both apps call this one rule, so a carrier alone behaves the same on both.
describe("shipmentSaveDecision (M8c, shared with web)", () => {
  it("blank over nothing stored changes nothing: no request, no 'cleared'", () => {
    expect(shipmentSaveDecision({}, "", "")).toEqual({ outcome: "nothing", payload: null });
    expect(
      shipmentSaveDecision({ shippingCarrier: null, shippingTrackingNumber: " " }, " ", ""),
    ).toEqual({ outcome: "nothing", payload: null });
  });
  it("carrier only (no number) over nothing stored is also nothing", () => {
    expect(shipmentSaveDecision({}, "UPS", "")).toEqual({ outcome: "nothing", payload: null });
  });
  it("blank, or a carrier alone, over a stored shipment clears it", () => {
    const cleared = {
      outcome: "cleared",
      payload: { shippingCarrier: "", shippingTrackingNumber: "" },
    };
    expect(shipmentSaveDecision({ shippingTrackingNumber: "1Z999" }, "", "")).toEqual(cleared);
    expect(shipmentSaveDecision({ shippingCarrier: "UPS" }, "", "")).toEqual(cleared);
    expect(shipmentSaveDecision({ shippingCarrier: "UPS" }, "FedEx", "  ")).toEqual(cleared);
  });
  it("a tracking number saves it with the chosen carrier", () => {
    expect(shipmentSaveDecision({}, "UPS", " 1Z999 ")).toEqual({
      outcome: "saved",
      payload: { shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" },
    });
  });
});

describe("shipmentNotShippedNote (M8d)", () => {
  it.each(["PENDING", "CONFIRMED", "DRAFT"])(
    "a SHIP order that is %s with tracking says so, without claiming a notification",
    (s) => {
      expect(shipmentNotShippedNote("SHIP", s, "1Z999")).toBe("Not shipped yet.");
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
