/**
 * B1127 — the "Order confirmed" copy helpers (the end-to-end proof is orders/order-confirmed-email-b1127.spec.ts).
 */
import { Test } from "@nestjs/testing";
import { FulfillPath, MessageChannel, NotificationEvent } from "@prisma/client";
import {
  DEFAULT_TEMPLATES,
  EVENT_CHANNELS,
  MessagingConfigService,
} from "./messaging-config.service";
import { extractVariables, renderTemplate } from "./messaging.helpers";
import {
  LEGACY_ORDER_CONFIRMED_BODY,
  orderConfirmedVars,
  upgradeLegacyDefaultBody,
} from "./order-confirmed-copy";
import { PrismaService } from "../prisma/prisma.service";
import { MeterService } from "../billing/meter.service";
import { MESSAGE_PROVIDER } from "./providers/message-provider.interface";
import { createMockPrisma } from "../testing/prisma-mock";

const CONFIRMED = NotificationEvent.ORDER_CONFIRMED;
const DATE = new Date("2026-07-14T00:00:00.000Z");
const body = DEFAULT_TEMPLATES[CONFIRMED].body;
const render = (vars: Record<string, string>) =>
  renderTemplate(body, { customerName: "Acme", orderNumber: "ORD-00001", ...vars });

describe("B1127 orderConfirmedVars", () => {
  it("ROUTE with a date: ' for delivery on <date>' and the stored total", () => {
    expect(
      orderConfirmedVars({ fulfillPath: FulfillPath.ROUTE, requestedDeliveryDate: DATE }, 127.08),
    ).toEqual({
      deliveryDate: "July 14, 2026",
      orderTotal: "$127.08",
      deliveryClause: " for delivery on July 14, 2026",
    });
  });

  it("ROUTE without a date, and an order that carries no fulfillPath at all (legacy row): an EMPTY clause", () => {
    expect(
      orderConfirmedVars({ fulfillPath: FulfillPath.ROUTE, requestedDeliveryDate: null }, 1)
        .deliveryClause,
    ).toBe("");
    expect(orderConfirmedVars({}, 1).deliveryClause).toBe("");
    expect(orderConfirmedVars({ requestedDeliveryDate: DATE }, 1).deliveryClause).toBe(
      " for delivery on July 14, 2026",
    );
  });

  it("SHIP: carrier wording whether or not a date is on the order", () => {
    for (const requestedDeliveryDate of [null, DATE]) {
      expect(
        orderConfirmedVars({ fulfillPath: FulfillPath.SHIP, requestedDeliveryDate }, 1)
          .deliveryClause,
      ).toBe(" and will ship by carrier");
    }
  });

  it("PICKUP: no delivery wording even if a date is present", () => {
    expect(
      orderConfirmedVars({ fulfillPath: FulfillPath.PICKUP, requestedDeliveryDate: DATE }, 1)
        .deliveryClause,
    ).toBe("");
  });

  it("a requested date that is an invalid string renders no clause (formatDate returns '')", () => {
    expect(
      orderConfirmedVars({ fulfillPath: FulfillPath.ROUTE, requestedDeliveryDate: "nope" }, 1)
        .deliveryClause,
    ).toBe("");
  });
});

describe("B1127 the shipped default body", () => {
  it("is exactly the owner-ruled copy, and every variable it names is supplied", () => {
    expect(body).toBe(
      "Hi {{customerName}}, your order {{orderNumber}} is confirmed{{deliveryClause}}. Total: {{orderTotal}}.",
    );
    const supplied = new Set([
      "customerName", // notifyEvent auto-fills it
      "orderNumber", // the firing site
      ...Object.keys(orderConfirmedVars({}, 0)),
    ]);
    expect(extractVariables(body).filter((v) => !supplied.has(v))).toEqual([]);
  });

  it("renders the three shapes with no stray 'on .' and no delivery word for a shipped order", () => {
    const route = (d: Date | null) =>
      render(orderConfirmedVars({ fulfillPath: "ROUTE", requestedDeliveryDate: d }, 127.08));
    expect(route(DATE)).toBe(
      "Hi Acme, your order ORD-00001 is confirmed for delivery on July 14, 2026. Total: $127.08.",
    );
    expect(route(null)).toBe("Hi Acme, your order ORD-00001 is confirmed. Total: $127.08.");
    const ship = render(orderConfirmedVars({ fulfillPath: "SHIP" }, 127.08));
    expect(ship).toBe(
      "Hi Acme, your order ORD-00001 is confirmed and will ship by carrier. Total: $127.08.",
    );
    expect(ship).not.toMatch(/deliver/i);
  });

  it("ROUTE with a date renders byte-identically to the pre-B1127 default (the sentence did not change)", () => {
    const vars = orderConfirmedVars({ fulfillPath: "ROUTE", requestedDeliveryDate: DATE }, 127.08);
    const all = { customerName: "Acme", orderNumber: "ORD-00001", ...vars };
    expect(renderTemplate(body, all)).toBe(renderTemplate(LEGACY_ORDER_CONFIRMED_BODY, all));
  });
});

describe("B1127 upgradeLegacyDefaultBody", () => {
  it("a stored body that IS the superseded default (trim-tolerant) becomes the current default", () => {
    expect(upgradeLegacyDefaultBody(CONFIRMED, LEGACY_ORDER_CONFIRMED_BODY, body)).toBe(body);
    expect(upgradeLegacyDefaultBody(CONFIRMED, `  ${LEGACY_ORDER_CONFIRMED_BODY}\n`, body)).toBe(
      body,
    );
  });

  it("any edit, even one character, is the business's own text and is returned untouched", () => {
    for (const mine of [
      LEGACY_ORDER_CONFIRMED_BODY.replace("Hi", "Hello"),
      `${LEGACY_ORDER_CONFIRMED_BODY} Thanks!`,
      "Order {{orderNumber}} is confirmed.",
      "",
    ]) {
      expect(upgradeLegacyDefaultBody(CONFIRMED, mine, body)).toBe(mine);
    }
  });

  it("only ORDER_CONFIRMED has a superseded default: the same text under another event is untouched", () => {
    expect(
      upgradeLegacyDefaultBody(
        NotificationEvent.DELIVERED,
        LEGACY_ORDER_CONFIRMED_BODY,
        DEFAULT_TEMPLATES[NotificationEvent.DELIVERED].body,
      ),
    ).toBe(LEGACY_ORDER_CONFIRMED_BODY);
  });
});

describe("B1127 settings matrix shows what will actually be sent", () => {
  async function matrixFor(storedBody: string) {
    const prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        MessagingConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: MeterService, useValue: { read: jest.fn().mockRejectedValue(new Error("x")) } },
        {
          provide: MESSAGE_PROVIDER,
          useValue: { send: jest.fn(), transports: jest.fn().mockReturnValue(true) },
        },
      ],
    }).compile();
    const pairs = (Object.keys(EVENT_CHANNELS) as NotificationEvent[]).flatMap((eventKey) =>
      EVENT_CHANNELS[eventKey].map((channel) => ({ eventKey, channel })),
    );
    prisma.notificationRule.findMany.mockResolvedValue(
      pairs.map((p, i) => ({ id: `r${i}`, ...p, enabled: true })),
    );
    prisma.messageTemplate.findMany.mockResolvedValue(
      pairs.map((p, i) => {
        const b = p.eventKey === CONFIRMED ? storedBody : DEFAULT_TEMPLATES[p.eventKey].body;
        return {
          id: `t${i}`,
          ...p,
          body: b,
          variables: extractVariables(b),
          waTemplateName: null,
          waApprovalStatus: "NONE",
          isActive: true,
        };
      }),
    );
    prisma.messagingSettings.findUnique.mockResolvedValue(null);
    const view = await mod.get(MessagingConfigService).getMatrix();
    const cell = view.events
      .find((e) => e.eventKey === CONFIRMED)!
      .channels.find((c) => c.channel === MessageChannel.EMAIL)!;
    return cell.template!;
  }

  it("a tenant still holding the superseded default sees the current default and its variables", async () => {
    const t = await matrixFor(LEGACY_ORDER_CONFIRMED_BODY);
    expect(t.body).toBe(body);
    expect(t.variables).toEqual(["customerName", "orderNumber", "deliveryClause", "orderTotal"]);
  });

  it("a tenant's own wording is shown exactly as stored", async () => {
    const mine = "Order {{orderNumber}} confirmed. Deliver on {{deliveryDate}}.";
    const t = await matrixFor(mine);
    expect(t.body).toBe(mine);
    expect(t.variables).toEqual(["orderNumber", "deliveryDate"]);
  });
});
