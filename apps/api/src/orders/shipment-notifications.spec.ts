import { NotificationEvent } from "@prisma/client";
import { DEFAULT_TEMPLATES } from "../messaging/messaging-config.service";
import { renderTemplate } from "../messaging/messaging.helpers";
import { shipmentVars } from "./shipment-notifications";

const UPS_URL = "https://www.ups.com/track?loc=en_US&tracknum=1Z999";

describe("shipmentVars", () => {
  it("known carrier + tracking: label, number, derived URL, and the ' Tracking: N — URL' line", () => {
    expect(shipmentVars({ shippingCarrier: "ups", shippingTrackingNumber: " 1Z999 " })).toEqual({
      carrier: "UPS",
      trackingNumber: "1Z999",
      trackingUrl: UPS_URL,
      trackingLine: ` Tracking: 1Z999 — ${UPS_URL}`,
    });
  });

  it("unknown carrier + tracking: no link, and the URL var falls back to 'via <carrier>'", () => {
    expect(
      shipmentVars({ shippingCarrier: "Acme Freight", shippingTrackingNumber: "AB1" }),
    ).toEqual({
      carrier: "Acme Freight",
      trackingNumber: "AB1",
      trackingUrl: "via Acme Freight",
      trackingLine: " Tracking: AB1",
    });
  });

  it("no tracking: an empty trackingLine, never a dangling label", () => {
    const v = shipmentVars({ shippingCarrier: "FedEx", shippingTrackingNumber: null });
    expect(v.trackingLine).toBe("");
    expect(v.trackingNumber).toBe("");
    expect(v.carrier).toBe("FedEx");
  });

  it("no carrier: 'the carrier'", () => {
    expect(shipmentVars({ shippingCarrier: null, shippingTrackingNumber: null }).carrier).toBe(
      "the carrier",
    );
  });
});

describe("default templates render as the owner specified", () => {
  const body = (e: NotificationEvent) => DEFAULT_TEMPLATES[e].body;

  it("ORDER_SHIPPED without tracking", () => {
    const v = shipmentVars({ shippingCarrier: "UPS", shippingTrackingNumber: null });
    expect(
      renderTemplate(body(NotificationEvent.ORDER_SHIPPED), {
        customerName: "Acme",
        orderNumber: "SO-1",
        carrier: v.carrier,
        trackingLine: v.trackingLine,
      }),
    ).toBe("Hi Acme, your order SO-1 has shipped with UPS.");
  });

  it("ORDER_SHIPPED with tracking", () => {
    const v = shipmentVars({ shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" });
    expect(
      renderTemplate(body(NotificationEvent.ORDER_SHIPPED), {
        customerName: "Acme",
        orderNumber: "SO-1",
        carrier: v.carrier,
        trackingLine: v.trackingLine,
      }),
    ).toBe(`Hi Acme, your order SO-1 has shipped with UPS. Tracking: 1Z999 — ${UPS_URL}`);
  });

  it("SHIPMENT_TRACKING_ADDED, known and unknown carrier", () => {
    const render = (carrier: string) => {
      const v = shipmentVars({ shippingCarrier: carrier, shippingTrackingNumber: "1Z999" });
      return renderTemplate(body(NotificationEvent.SHIPMENT_TRACKING_ADDED), {
        customerName: "Acme",
        orderNumber: "SO-1",
        trackingNumber: v.trackingNumber,
        trackingUrl: v.trackingUrl,
      });
    };
    expect(render("UPS")).toBe(`Hi Acme, tracking for order SO-1: 1Z999 — ${UPS_URL}`);
    expect(render("Acme Freight")).toBe(
      "Hi Acme, tracking for order SO-1: 1Z999 — via Acme Freight",
    );
  });
});
