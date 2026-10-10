/**
 * B1127 — the "Order confirmed" email read "...is confirmed for delivery on . Total: $127.08." when
 * the order had no requestedDeliveryDate, and used delivery wording for a carrier-shipped (SHIP) order.
 *
 * End to end: the REAL `OrdersService.changeStatus` (harness) -> the REAL `MessagingService.notifyEvent`
 * -> the template the tenant has STORED -> the body handed to the email provider. Only the data layer
 * and the provider are mocked. Lives beside, not inside, orders.service.spec.ts (size-ratchet cap).
 *
 * Two kinds of stored template are exercised, because `MessageTemplate` rows are per-tenant copies
 * seeded once from `DEFAULT_TEMPLATES` (`seedDefaultsFor`, skipDuplicates) and editable in Settings:
 *   - LEGACY: the body every already-seeded tenant still holds (the pre-B1127 default, pinned here);
 *   - CURRENT: whatever `DEFAULT_TEMPLATES` ships now (what a never-seeded tenant gets);
 *   - CUSTOM: a business's own wording, which must keep rendering exactly as written.
 */
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { MessageChannel, NotificationEvent } from "@prisma/client";
import { MessagingService } from "../messaging/messaging.service";
import { DEFAULT_TEMPLATES } from "../messaging/messaging-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

const LEGACY_BODY =
  "Hi {{customerName}}, your order {{orderNumber}} is confirmed for delivery on {{deliveryDate}}. Total: {{orderTotal}}.";
const CUSTOM_BODY =
  "{{customerName}}: order {{orderNumber}} is in. Delivery: {{deliveryDate}}. We charge {{orderTotal}}.";

const DATE = new Date("2026-07-14T00:00:00.000Z");

/** Confirms a PENDING order and returns the exact body the email provider was handed. */
async function confirmAndRead(opts: {
  storedBody: string;
  order: { fulfillPath?: "ROUTE" | "SHIP" | "PICKUP"; requestedDeliveryDate?: Date | null };
}): Promise<string> {
  const { service, prisma, sideEffects } = await buildOrdersService();

  // The tenant's messaging side: one enabled EMAIL rule + the stored template.
  const mprisma = createMockPrisma();
  const provider = {
    send: jest.fn().mockResolvedValue({ providerMsgId: "m-1", status: "queued" }),
    transports: jest.fn().mockReturnValue(true),
  };
  const messaging = new MessagingService(mprisma as any, { increment: jest.fn() } as any, provider);
  mprisma.notificationRule.findMany.mockResolvedValue([{ channel: MessageChannel.EMAIL }]);
  mprisma.messageTemplate.findFirst.mockResolvedValue({
    body: opts.storedBody,
    isActive: true,
    waTemplateName: null,
  });
  mprisma.customer.findFirst.mockResolvedValue({
    id: "cust-1",
    businessName: "Acme Foods",
    phone: null,
    mobile: null,
    email: "buyer@example.com",
    smsConsent: false,
    waConsent: false,
    orderStatusEmails: true,
  });
  mprisma.messageThread.findFirst.mockResolvedValue({ id: "thread-1" });
  mprisma.message.create.mockResolvedValue({ id: "msg-1" });
  mprisma.messageThread.update.mockResolvedValue({ id: "thread-1" });
  mprisma.messagingSettings.findUnique.mockResolvedValue(null);

  let pending: Promise<void> = Promise.resolve();
  sideEffects.messaging.notifyEvent.mockImplementation((...args: unknown[]) => {
    pending = (messaging.notifyEvent as (...a: unknown[]) => Promise<void>)(...args);
    return pending;
  });

  const order = {
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-00001",
    status: "PENDING" as const,
    source: "APP" as const,
    total: 127.08,
    routeRunId: null,
    routeRunStopId: null,
    customer: { businessName: "Acme Foods" },
    requestedDeliveryDate: null,
    fulfillPath: "ROUTE" as const,
    ...opts.order,
  };
  prisma.order.findUnique.mockResolvedValue(order);
  prisma.order.update.mockResolvedValue({ ...order, status: "CONFIRMED" });

  await service.changeStatus("ord-1", { status: "CONFIRMED" as any }, operatorPayload as never);
  await pending;

  expect(sideEffects.messaging.notifyEvent).toHaveBeenCalledWith(
    NotificationEvent.ORDER_CONFIRMED,
    expect.anything(),
  );
  expect(provider.send).toHaveBeenCalledTimes(1);
  return provider.send.mock.calls[0][0].body as string;
}

describe.each([
  ["LEGACY stored body (every already-seeded tenant)", LEGACY_BODY],
  [
    "CURRENT DEFAULT_TEMPLATES body (a never-seeded tenant)",
    DEFAULT_TEMPLATES.ORDER_CONFIRMED.body,
  ],
])("B1127 order-confirmed email — %s", (_label, storedBody) => {
  it("ROUTE with a requested date: the sentence is unchanged", async () => {
    const body = await confirmAndRead({
      storedBody,
      order: { fulfillPath: "ROUTE", requestedDeliveryDate: DATE },
    });
    expect(body).toBe(
      "Hi Acme Foods, your order ORD-00001 is confirmed for delivery on July 14, 2026. Total: $127.08.",
    );
  });

  it("ROUTE with NO requested date: the date clause is omitted entirely (never 'for delivery on .')", async () => {
    const body = await confirmAndRead({
      storedBody,
      order: { fulfillPath: "ROUTE", requestedDeliveryDate: null },
    });
    expect(body).not.toContain("for delivery on .");
    expect(body).toBe("Hi Acme Foods, your order ORD-00001 is confirmed. Total: $127.08.");
  });

  it("SHIP: carrier wording, no delivery-date wording, with or without a date on the order", async () => {
    for (const requestedDeliveryDate of [null, DATE]) {
      const body = await confirmAndRead({
        storedBody,
        order: { fulfillPath: "SHIP", requestedDeliveryDate },
      });
      expect(body).toBe(
        "Hi Acme Foods, your order ORD-00001 is confirmed and will ship by carrier. Total: $127.08.",
      );
      expect(body).not.toMatch(/deliver/i);
    }
  });

  it("buyer-placed order (source APP, nothing but the buyer's own fields): same rules, ROUTE and SHIP", async () => {
    // A buyer-placed order reaches CONFIRMED through the same changeStatus site as a staff-keyed one
    // (it is the only ORDER_CONFIRMED firing site) and carries no requested date unless the buyer chose one.
    const route = await confirmAndRead({ storedBody, order: { fulfillPath: "ROUTE" } });
    expect(route).toBe("Hi Acme Foods, your order ORD-00001 is confirmed. Total: $127.08.");
    const ship = await confirmAndRead({ storedBody, order: { fulfillPath: "SHIP" } });
    expect(ship).toBe(
      "Hi Acme Foods, your order ORD-00001 is confirmed and will ship by carrier. Total: $127.08.",
    );
  });
});

describe("B1127 order-confirmed email — a tenant's CUSTOM template", () => {
  it("still renders exactly as the business wrote it, from the same variables", async () => {
    const withDate = await confirmAndRead({
      storedBody: CUSTOM_BODY,
      order: { fulfillPath: "ROUTE", requestedDeliveryDate: DATE },
    });
    expect(withDate).toBe(
      "Acme Foods: order ORD-00001 is in. Delivery: July 14, 2026. We charge $127.08.",
    );
    const noDate = await confirmAndRead({
      storedBody: CUSTOM_BODY,
      order: { fulfillPath: "ROUTE", requestedDeliveryDate: null },
    });
    expect(noDate).toBe("Acme Foods: order ORD-00001 is in. Delivery: . We charge $127.08.");
  });

  it("a custom body that has the customer's wording AND the legacy sentence inside it is NOT rewritten", async () => {
    const mine = `${LEGACY_BODY} Thanks for choosing us!`;
    const body = await confirmAndRead({
      storedBody: mine,
      order: { fulfillPath: "ROUTE", requestedDeliveryDate: DATE },
    });
    expect(body).toBe(
      "Hi Acme Foods, your order ORD-00001 is confirmed for delivery on July 14, 2026. Total: $127.08. Thanks for choosing us!",
    );
  });
});
