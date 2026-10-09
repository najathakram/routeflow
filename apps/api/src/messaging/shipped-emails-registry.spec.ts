import { MessageChannel, NotificationEvent } from "@prisma/client";
import { DEFAULT_ON, DEFAULT_TEMPLATES, EVENT_CHANNELS } from "./messaging-config.service";
import { NOTIFICATION_AUDIENCE, NOTIFICATION_TRIGGERS } from "./notification-triggers";

/** Pins the registry entries for the two carrier-shipping events (the exhaustive Records already
 *  fail to compile without them; this pins their VALUES). */
describe("carrier-shipping events: registries", () => {
  const events = [NotificationEvent.ORDER_SHIPPED, NotificationEvent.SHIPMENT_TRACKING_ADDED];

  it.each(events)("%s: all four customer channels, audience CUSTOMER, registered trigger", (e) => {
    expect([...EVENT_CHANNELS[e]].sort()).toEqual(
      [
        MessageChannel.EMAIL,
        MessageChannel.PORTAL,
        MessageChannel.SMS,
        MessageChannel.WHATSAPP,
      ].sort(),
    );
    expect(NOTIFICATION_AUDIENCE[e]).toBe("CUSTOMER");
    expect(NOTIFICATION_TRIGGERS.has(e)).toBe(true);
  });

  it.each(events)("%s: DEFAULT_ON for EMAIL and PORTAL only", (e) => {
    expect(DEFAULT_ON.has(`${e}:EMAIL`)).toBe(true);
    expect(DEFAULT_ON.has(`${e}:PORTAL`)).toBe(true);
    expect(DEFAULT_ON.has(`${e}:SMS`)).toBe(false);
    expect(DEFAULT_ON.has(`${e}:WHATSAPP`)).toBe(false);
  });

  it("READY_FOR_PICKUP: seeded like the others (4 channels, CUSTOMER, EMAIL+PORTAL on) and a registered trigger (the PICKUP handover in OrdersService.changeStatus fires it)", () => {
    const e = NotificationEvent.READY_FOR_PICKUP;
    expect(EVENT_CHANNELS[e]).toHaveLength(4);
    expect(NOTIFICATION_AUDIENCE[e]).toBe("CUSTOMER");
    expect(DEFAULT_ON.has(`${e}:EMAIL`) && DEFAULT_ON.has(`${e}:PORTAL`)).toBe(true);
    expect(DEFAULT_ON.has(`${e}:SMS`) || DEFAULT_ON.has(`${e}:WHATSAPP`)).toBe(false);
    expect(NOTIFICATION_TRIGGERS.has(e)).toBe(true);
    expect(DEFAULT_TEMPLATES[e].body).toBe(
      "Hi {{customerName}}, your order {{orderNumber}} is ready for pickup.{{pickupLine}}",
    );
  });

  it("default bodies are exactly the owner-approved copy", () => {
    expect(DEFAULT_TEMPLATES[NotificationEvent.ORDER_SHIPPED].body).toBe(
      "Hi {{customerName}}, your order {{orderNumber}} has shipped with {{carrier}}.{{trackingLine}}",
    );
    expect(DEFAULT_TEMPLATES[NotificationEvent.SHIPMENT_TRACKING_ADDED].body).toBe(
      "Hi {{customerName}}, tracking for order {{orderNumber}}: {{trackingNumber}} — {{trackingUrl}}",
    );
  });
});
