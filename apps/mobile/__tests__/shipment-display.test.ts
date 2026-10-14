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
import {
  CARRIER_HINT,
  needsCarrierHint,
  shipmentSaveDecision,
} from "@routeflow/types/shipment-save";

// The SAME table is pinned on web in apps/web/components/ShipmentCard.test.tsx (carrier-only saves, M8):
// both apps call this one rule, so a carrier alone behaves the same on both.
describe("shipmentSaveDecision (M8c, shared with web)", () => {
  it("both empty over nothing stored: nothing (no request, no toast)", () => {
    expect(shipmentSaveDecision({}, "", "")).toEqual({ outcome: "nothing", payload: null });
    expect(
      shipmentSaveDecision({ shippingCarrier: null, shippingTrackingNumber: " " }, " ", ""),
    ).toEqual({ outcome: "nothing", payload: null });
  });
  it("both empty over a stored shipment clears it", () => {
    const cleared = {
      outcome: "cleared",
      payload: { shippingCarrier: "", shippingTrackingNumber: "" },
    };
    expect(shipmentSaveDecision({ shippingTrackingNumber: "1Z999" }, "", "")).toEqual(cleared);
    expect(shipmentSaveDecision({ shippingCarrier: "UPS" }, " ", "  ")).toEqual(cleared);
  });
  it("a carrier alone saves, new or over a legacy carrier-only row (never cleared)", () => {
    expect(shipmentSaveDecision({}, "UPS", "")).toEqual({
      outcome: "saved",
      payload: { shippingCarrier: "UPS", shippingTrackingNumber: "" },
    });
    expect(shipmentSaveDecision({ shippingCarrier: "UPS" }, "UPS", "")).toEqual({
      outcome: "saved",
      payload: { shippingCarrier: "UPS", shippingTrackingNumber: "" },
    });
  });
  it("a tracking number saves with the chosen carrier", () => {
    expect(shipmentSaveDecision({}, "UPS", " 1Z999 ")).toEqual({
      outcome: "saved",
      payload: { shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" },
    });
    expect(shipmentSaveDecision({}, "", "1Z999")).toEqual({
      outcome: "saved",
      payload: { shippingCarrier: "", shippingTrackingNumber: "1Z999" },
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
  it("a carrier-only shipment says it has not shipped yet too", () => {
    expect(shipmentNotShippedNote("SHIP", "PENDING", "1Z999", "UPS")).toBe("Not shipped yet.");
    expect(shipmentNotShippedNote("SHIP", "PENDING", "", "UPS")).toBe("Not shipped yet.");
  });
  it("nothing recorded, not SHIP, or no status: no note", () => {
    expect(shipmentNotShippedNote("SHIP", "PENDING", "", "")).toBeNull();
    expect(shipmentNotShippedNote("SHIP", "PENDING", null, null)).toBeNull();
    expect(shipmentNotShippedNote("ROUTE", "PENDING", "1Z999", "UPS")).toBeNull();
    expect(shipmentNotShippedNote("SHIP", undefined, "1Z999", "UPS")).toBeNull();
  });
});

describe("carrier hint (M8, shared with web)", () => {
  it("says to pick a carrier for a tracking link, only when a number is entered with no carrier", () => {
    expect(CARRIER_HINT).toBe("Pick a carrier to give your customer a tracking link");
    expect(needsCarrierHint("", "1Z999")).toBe(true);
    expect(needsCarrierHint("UPS", "1Z999")).toBe(false);
    expect(needsCarrierHint("", "")).toBe(false);
  });
  it("a number with no carrier still saves (no carrier sent)", () => {
    expect(shipmentSaveDecision({}, "", "1Z999")).toEqual({
      outcome: "saved",
      payload: { shippingCarrier: "", shippingTrackingNumber: "1Z999" },
    });
  });
});
